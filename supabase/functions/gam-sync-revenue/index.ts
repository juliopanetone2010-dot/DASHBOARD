// Sincroniza receita do Google Ad Manager (REST API v1 beta)
// - Autentica via JWT (service account)
// - Roda 2 reports: por AD_UNIT_NAME e por PLACEMENT_NAME
// - Faz upsert em `placements` e atualiza `revenue/impressions/ecpm`
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";
const ALLOWED_PRESETS = new Set(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const debug: string[] = [];
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    let datePreset = "LAST_7_DAYS";
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    let requestedSiteId: string | null = null;
    let requestedAccountIds: string[] = [];
    let includeYesterdayFallback = false;
    let testMode = false;
    try {
      const body = await req.json().catch(() => ({}));
      const p = String((body as any)?.date_preset ?? "").toUpperCase();
      if (ALLOWED_PRESETS.has(p)) datePreset = p;
      dateFrom = typeof (body as any)?.from === "string" ? (body as any).from : null;
      dateTo = typeof (body as any)?.to === "string" ? (body as any).to : null;
      requestedSiteId = typeof (body as any)?.site_id === "string" ? (body as any).site_id : null;
      requestedAccountIds = Array.isArray((body as any)?.account_ids)
        ? (body as any).account_ids.filter((id: unknown) => typeof id === "string" && id.length > 0)
        : [];
      includeYesterdayFallback = Boolean((body as any)?.include_yesterday_fallback);
      testMode = Boolean((body as any)?.test);
    } catch (_) { /* */ }

    const saJsonRaw = Deno.env.get("GAM_SERVICE_ACCOUNT_JSON");
    if (!saJsonRaw) return json({ error: "GAM_SERVICE_ACCOUNT_JSON não configurada" });
    let sa: { client_email: string; private_key: string };
    try {
      sa = JSON.parse(saJsonRaw);
    } catch {
      return json({ error: "GAM_SERVICE_ACCOUNT_JSON inválido (não é JSON)" });
    }
    if (!sa.client_email || !sa.private_key) {
      return json({ error: "Service Account JSON sem client_email/private_key" });
    }

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let sitesQuery = admin
      .from("sites")
      .select("id, name, domain, network_code")
      .eq("user_id", userId);
    if (requestedSiteId) sitesQuery = sitesQuery.eq("id", requestedSiteId);
    const { data: sites, error: sErr } = await sitesQuery;
    if (sErr) return json({ error: sErr.message });
    if (!sites || sites.length === 0) return json({ error: "Nenhum site cadastrado" });

    const accessToken = await getAccessToken(sa);
    debug.push("got access token");
    // Receita do GAM fica em USD; gasto do Ads fica na moeda nativa (BRL nas contas BR).
    const fxRates = await getFxRates(debug);

    // Agrupa sites por network_code
    const byNetwork = new Map<string, typeof sites>();
    for (const s of sites) {
      const list = byNetwork.get(s.network_code) ?? [];
      list.push(s);
      byNetwork.set(s.network_code, list);
    }

    const summary: Array<Record<string, unknown>> = [];

    for (const [networkCode, networkSites] of byNetwork) {
      try {
        const ranges = buildGamRanges(datePreset, dateFrom, dateTo, includeYesterdayFallback);

        // Reports legados (ad unit + placement) — apenas para inspeção/UI de placements.
        const adUnitRows = (await Promise.all(ranges.map((range) =>
          runReport({ networkCode, accessToken, range, dimensions: ["DATE", "AD_UNIT_NAME"], debug })
        ))).flat().map((r) => ({ ...r, name: r.dims[1] ?? "(unknown)" }));
        const placementRows = (await Promise.all(ranges.map((range) =>
          runReport({ networkCode, accessToken, range, dimensions: ["DATE", "PLACEMENT_NAME"], debug })
        ))).flat().map((r) => ({ ...r, name: r.dims[1] ?? "(unknown)" }));

        // 1) Descobre IDs dos targeting keys utm_source, utm_campaign, utm_placement
        const utmKeyIds = await fetchUtmKeyIds(networkCode, accessToken, debug);
        const attribution = await collectUtmAttribution({ networkCode, accessToken, ranges, utmKeyIds, debug });
        const utmRows = attribution.retentionRows;
        const googleCampaignRows = attribution.googleCampaignRows;
        const googlePlacementRows = attribution.googlePlacementRows;
        const totals = googleCampaignRows.reduce(
          (acc, r) => ({ revenue: acc.revenue + r.revenue, impressions: acc.impressions + r.impressions }),
          { revenue: 0, impressions: 0 },
        );
        const today = new Date().toISOString().slice(0, 10);

        // Persiste placements/ad_units para inspeção (sem afetar ROI)
        const persistRows = async (rows: Array<{ date: string | null; name: string; impressions: number; revenue: number }>, kind: "ad_unit" | "placement") => {
          if (rows.length === 0) return;
          const siteForRow = networkSites[0];
          const payload = rows.map((r) => {
            const ecpm = r.impressions > 0 ? (r.revenue / r.impressions) * 1000 : 0;
            return {
              user_id: userId, site_id: siteForRow.id, site: siteForRow.name,
              ad_unit: kind === "ad_unit" ? r.name : null,
              placement_key: `${kind}:${networkCode}:${r.name}`,
              date: r.date ?? today, impressions: r.impressions, revenue: r.revenue, ecpm,
            };
          });
          const CHUNK = 500;
          for (let i = 0; i < payload.length; i += CHUNK) {
            await admin.from("placements").upsert(payload.slice(i, i + CHUNK), { onConflict: "user_id,placement_key,date" });
          }
        };

        if (!testMode) {
          await persistRows(adUnitRows, "ad_unit");
          await persistRows(placementRows, "placement");
          await persistCampaignSourceRevenueFromUtm(admin, userId, networkSites[0]?.id, utmRows, debug, expandFixedDates(ranges));
          await applyGoogleUtmRevenue(admin, userId, networkSites[0]?.id, googleCampaignRows, googlePlacementRows, fxRates, debug, expandFixedDates(ranges));
        }

        summary.push({
          network_code: networkCode,
          sites: networkSites.map((s) => s.name),
          ad_unit_rows: adUnitRows.length,
          placement_rows: placementRows.length,
          utm_rows: utmRows.length,
          utm_keys_found: utmKeyIds,
          google_rows: googleCampaignRows.length,
          google_placement_rows: googlePlacementRows.length,
          attribution_source: attribution.campaignSource,
          placement_source: attribution.placementSource,
          attribution_rule: "utm_source=google→ROI/ROAS; demais→retenção (sem fallback)",
          currency: "USD",
          usd_brl_rate: fxRates.usdBrl,
          total_revenue_usd: totals.revenue,
          total_impressions: totals.impressions,
          date_range: ranges.map((r) => r.debugLabel),
          site_id: requestedSiteId ?? null,
          rows_returned: googleCampaignRows.length,
          ecpm: totals.impressions > 0 ? (totals.revenue / totals.impressions) * 1000 : 0,
        });
      } catch (e) {
        summary.push({ network_code: networkCode, error: String(e) });
      }
    }

    const hasErrors = summary.some((s) => typeof s.error === "string");
    const gamDebug = {
      gam_called: true,
      rows_returned: summary.reduce((acc, s) => acc + Number(s.rows_returned ?? 0), 0),
      date_range: summary.flatMap((s) => Array.isArray(s.date_range) ? s.date_range : []),
      site: requestedSiteId ?? "all",
      error: summary.find((s) => typeof s.error === "string")?.error ?? null,
    };

    // Atualiza last_synced_at/status sem marcar como conectado quando o GAM recusou a chamada
    await admin.from("gam_accounts")
      .update({ last_synced_at: new Date().toISOString(), status: hasErrors ? "pending" : "connected" })
      .eq("user_id", userId);

    return json({ ok: true, date_preset: datePreset, summary, gam_debug: gamDebug, debug });
  } catch (e) {
    console.error("[gam-sync-revenue] uncaught", e);
    return json({ error: String(e), debug });
  }
});

interface ReportRow { date: string | null; dims: string[]; impressions: number; revenue: number; }
interface AttributedRow { date: string | null; impressions: number; revenue: number; source: string; cid: string | null; placement: string | null; raw: string; }
interface FxRates { usdBrl: number; }
interface UtmKeyIds { utm_source: string | null; utm_campaign: string | null; utm_placement: string | null; }
interface AttributionResult {
  retentionRows: AttributedRow[];
  googleCampaignRows: AttributedRow[];
  googlePlacementRows: AttributedRow[];
  campaignSource: string;
  placementSource: string;
}

interface GamRange { dateRange: Record<string, unknown>; debugLabel: string; }

async function getFxRates(debug: string[]): Promise<FxRates> {
  // Fonte primária: open.er-api.com (estável, sem quota agressiva)
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json();
    const rate = Number(data?.rates?.BRL);
    if (Number.isFinite(rate) && rate > 0) {
      debug.push(`[currency] USD→BRL ${rate} (open.er-api)`);
      return { usdBrl: rate };
    }
  } catch (e) {
    debug.push(`[currency] open.er-api falhou: ${String(e)}`);
  }
  // Fallback 1: awesomeapi (pode dar 429)
  try {
    const res = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL");
    const data = await res.json();
    const rate = Number(data?.USDBRL?.bid);
    if (Number.isFinite(rate) && rate > 0) {
      debug.push(`[currency] USD→BRL ${rate} (awesomeapi)`);
      return { usdBrl: rate };
    }
  } catch (e) {
    debug.push(`[currency] awesomeapi falhou: ${String(e)}`);
  }
  // Fallback final: cotação aproximada atual
  debug.push(`[currency] usando fallback hardcoded 4.97`);
  return { usdBrl: 4.97 };
}

function buildGamRanges(datePreset: string, from: string | null, to: string | null, includeYesterdayFallback: boolean): GamRange[] {
  const valid = (d: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const fixed = (start: string, end: string): GamRange => ({
    dateRange: { fixed: { startDate: dateObj(start), endDate: dateObj(end) } },
    debugLabel: `${start}..${end}`,
  });
  const ranges = valid(from) && valid(to)
    ? [fixed(from!, to!)]
    : [{ dateRange: { relative: datePreset }, debugLabel: datePreset }];
  if (includeYesterdayFallback) {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const iso = y.toISOString().slice(0, 10);
    if (!ranges.some((r) => r.debugLabel.includes(iso))) ranges.push(fixed(iso, iso));
  }
  return ranges;
}

function expandFixedDates(ranges: GamRange[]): string[] {
  const dates: string[] = [];
  for (const r of ranges) {
    const fixed = (r.dateRange as any)?.fixed;
    if (!fixed?.startDate || !fixed?.endDate) continue;
    const start = new Date(Date.UTC(fixed.startDate.year, fixed.startDate.month - 1, fixed.startDate.day));
    const end = new Date(Date.UTC(fixed.endDate.year, fixed.endDate.month - 1, fixed.endDate.day));
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  return dates;
}

function expandToDailyGamRanges(ranges: GamRange[]): Array<{ date: string | null; range: GamRange }> {
  const dates = expandFixedDates(ranges);
  if (dates.length === 0) return ranges.map((range) => ({ date: null, range }));
  return dates.map((date) => ({
    date,
    range: {
      dateRange: { fixed: { startDate: dateObj(date), endDate: dateObj(date) } },
      debugLabel: date,
    },
  }));
}

function dateObj(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function normalizePlacement(s: string): string {
  const t = (s || "").trim().toLowerCase();
  const appMatch = t.match(/mobileapp::\d+-(.+)$/i);
  if (appMatch) return appMatch[1];
  try {
    const u = new URL(t.startsWith("http") ? t : `https://${t}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return t.replace(/^www\./, "");
  }
}

// utm_placement vem como "{campaignid}_{placement}". Extrai a parte do placement.
function extractPlacementValue(raw: string, cid: string | null): string | null {
  if (!raw) return null;
  const decoded = safeDecode(raw);
  const m = decoded.match(/^(\d{6,})[_\-:](.+)$/);
  if (m) return normalizePlacement(m[2]);
  if (cid && decoded.startsWith(cid)) return normalizePlacement(decoded.slice(cid.length).replace(/^[_\-:]/, ""));
  return normalizePlacement(decoded);
}

function extractCampaignId(raw: string | null | undefined): string | null {
  const decoded = safeDecode(String(raw ?? "").trim());
  if (!decoded || decoded === "(not applicable)" || decoded === "(empty)") return null;
  const m = decoded.match(/(\d{6,})/);
  return m ? m[1] : null;
}

function isRealValue(raw: string | null | undefined): boolean {
  const value = String(raw ?? "").trim();
  return !!value && value !== "(not applicable)" && value !== "(empty)";
}

function parseKeyValueDimension(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const decoded = safeDecode(String(raw ?? ""));
  const normalized = decoded.replace(/[\n\r;]+/g, ",").replace(/&/g, ",");
  for (const part of normalized.split(",")) {
    const m = part.trim().match(/^([^=~|]+)[=~](.+)$/);
    if (!m) continue;
    const key = m[1].replace(/^\*/, "").replace(/^custom targeting\s*/i, "").trim().toLowerCase();
    const value = m[2].split("|")[0]?.replace(/^\*/, "").trim() ?? "";
    if (key) out[key] = value;
  }
  return out;
}

// Lista custom targeting keys e descobre IDs de utm_source/utm_campaign/utm_placement.
async function fetchUtmKeyIds(
  networkCode: string,
  accessToken: string,
  debug: string[],
): Promise<UtmKeyIds> {
  const wanted: Record<string, string | null> = { utm_source: null, utm_campaign: null, utm_placement: null };
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const url = new URL(`${GAM_BASE}/networks/${networkCode}/customTargetingKeys`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`customTargetingKeys retorno não-JSON: ${text.slice(0, 200)}`); }
    if (!res.ok) throw new Error(`customTargetingKeys failed (${res.status}): ${text.slice(0, 300)}`);
    const keys = (json.customTargetingKeys ?? []) as Array<{ name?: string; adTagName?: string; customTargetingKeyId?: string }>;
    for (const k of keys) {
      const name = (k.adTagName ?? "").toLowerCase();
      const id = String(k.customTargetingKeyId ?? (k.name ?? "").split("/").pop() ?? "");
      if (!id) continue;
      if (name in wanted && !wanted[name]) wanted[name] = id;
    }
    pageToken = json.nextPageToken;
    pages++;
    if (pages > 20) break;
  } while (pageToken);
  debug.push(`[customTargetingKeys] utm_source=${wanted.utm_source} utm_campaign=${wanted.utm_campaign} utm_placement=${wanted.utm_placement}`);
  return wanted as any;
}

async function collectUtmAttribution(args: {
  networkCode: string; accessToken: string; ranges: GamRange[]; utmKeyIds: UtmKeyIds; debug: string[];
}): Promise<AttributionResult> {
  const { networkCode, accessToken, ranges, utmKeyIds, debug } = args;
  const empty: AttributionResult = { retentionRows: [], googleCampaignRows: [], googlePlacementRows: [], campaignSource: "none", placementSource: "none" };
  if (!utmKeyIds.utm_source) {
    debug.push(`[${networkCode}/UTM] chave utm_source ausente; sem atribuição real por origem`);
    return empty;
  }

  const customCriteriaCandidate = await runCustomCriteriaCandidate(networkCode, accessToken, ranges, debug);
  const keyValueCandidate = await runKeyValuesNameCandidate(networkCode, accessToken, ranges, debug);
  const campaignCandidates = utmKeyIds.utm_campaign
    ? await runUtmPairCandidates(networkCode, accessToken, ranges, utmKeyIds.utm_source, utmKeyIds.utm_campaign, "utm_source", "utm_campaign", debug)
    : [];
  const placementCandidates = utmKeyIds.utm_placement
    ? await runUtmPairCandidates(networkCode, accessToken, ranges, utmKeyIds.utm_source, utmKeyIds.utm_placement, "utm_source", "utm_placement", debug)
    : [];

  const campaignCandidatesWithKv = [customCriteriaCandidate, keyValueCandidate, ...campaignCandidates].filter(Boolean) as Array<{ label: string; rows: AttributedRow[] }>;
  const placementCandidatesWithKv = [customCriteriaCandidate, keyValueCandidate, ...placementCandidates].filter(Boolean) as Array<{ label: string; rows: AttributedRow[] }>;

  const campaignPick = campaignCandidatesWithKv.find((c) => c.rows.some((r) => r.source === "google" && r.cid)) ?? campaignCandidatesWithKv[0];
  const placementPick = placementCandidatesWithKv.find((c) => c.rows.some((r) => r.source === "google" && r.cid && r.placement)) ?? placementCandidatesWithKv[0];

  const directCampaignRows = campaignPick?.rows ?? [];
  const placementRowsAll = placementPick?.rows ?? [];
  const placementRows = placementRowsAll.filter((r) => r.placement);
  const directGoogleRows = directCampaignRows.filter((r) => r.source === "google" && r.cid);
  const placementGoogleRows = placementRows.filter((r) => r.source === "google" && r.cid);
  const googleCampaignRows = directGoogleRows.length > 0 ? directGoogleRows : placementGoogleRows;
  const retentionRows = directCampaignRows.length > 0
    ? directCampaignRows
    : (placementRowsAll.length > 0 ? placementRowsAll : placementRows);

  debug.push(`[${networkCode}/ATTRIBUTION] campanha=${campaignPick?.label ?? "none"}; placement=${placementPick?.label ?? "none"}; google_campaign_rows=${googleCampaignRows.length}; google_placement_rows=${placementGoogleRows.length}`);
  return {
    retentionRows,
    googleCampaignRows,
    googlePlacementRows: placementGoogleRows,
    campaignSource: directGoogleRows.length > 0 ? (campaignPick?.label ?? "none") : (placementGoogleRows.length > 0 ? `${placementPick?.label ?? "placement"}→campaign_id_from_utm_placement` : "none"),
    placementSource: placementPick?.label ?? "none",
  };
}

async function runUtmPairCandidates(
  networkCode: string,
  accessToken: string,
  ranges: GamRange[],
  sourceKeyId: string,
  valueKeyId: string,
  sourceName: string,
  valueName: "utm_campaign" | "utm_placement",
  debug: string[],
): Promise<Array<{ label: string; rows: AttributedRow[] }>> {
  const candidates = [
    { label: `EKV_DIMENSION (${sourceName}+${valueName})`, dims: ["DATE", "EKV_DIMENSION_0_VALUE", "EKV_DIMENSION_1_VALUE"], field: "ekvDimensionKeyIds" as const },
    { label: `CUSTOM_DIMENSION (${sourceName}+${valueName})`, dims: ["DATE", "CUSTOM_DIMENSION_0_VALUE", "CUSTOM_DIMENSION_1_VALUE"], field: "customDimensionKeyIds" as const },
  ];
  const out: Array<{ label: string; rows: AttributedRow[] }> = [];
  for (const c of candidates) {
    try {
      const reportRows = (await Promise.all(ranges.map((range) =>
        runReport({ networkCode, accessToken, range, dimensions: c.dims, dimensionKeyIdsField: c.field, dimensionKeyIds: [sourceKeyId, valueKeyId], debug })
      ))).flat();
      const rows = reportRows.map((r) => {
        const sourceRaw = r.dims[1] || "";
        const valueRaw = r.dims[2] || "";
        const source = safeDecode(sourceRaw).toLowerCase().trim() || "unknown";
        const cid = valueName === "utm_campaign" ? extractCampaignId(valueRaw) : extractCampaignId(valueRaw);
        const placement = valueName === "utm_placement" && isRealValue(valueRaw) ? extractPlacementValue(valueRaw, cid) : null;
        return { date: r.date, impressions: r.impressions, revenue: r.revenue, source, cid, placement, raw: `${c.label}|utm_source_raw=${sourceRaw}|${valueName}_raw=${valueRaw}` };
      });
      debugUtmCandidate(networkCode, c.label, valueName, rows, debug);
      out.push({ label: c.label, rows });
    } catch (e) {
      debug.push(`[${networkCode}/${c.label}] erro=${String(e).slice(0, 500)}`);
    }
  }
  return out;
}

async function runKeyValuesNameCandidate(
  networkCode: string,
  accessToken: string,
  ranges: GamRange[],
  debug: string[],
): Promise<{ label: string; rows: AttributedRow[] }> {
  const label = "KEY_VALUES_NAME (URL params dinâmicos)";
  try {
    const dailyRanges = expandToDailyGamRanges(ranges);
    const reportRows = (await Promise.all(dailyRanges.map(async ({ range, date }) => {
      const rows = await runReport({ networkCode, accessToken, range, dimensions: ["KEY_VALUES_NAME"], debug });
      return rows.map((r) => ({ ...r, date: r.date ?? date }));
    }))).flat();
    const withUtm = rowsFromKeyValueReportRows(reportRows, label);
    debugUtmCandidate(networkCode, label, "utm_campaign+utm_placement", withUtm, debug);
    return { label, rows: withUtm };
  } catch (e) {
    debug.push(`[${networkCode}/${label}] erro=${String(e).slice(0, 500)}`);
    return { label, rows: [] };
  }
}

async function runCustomCriteriaCandidate(
  networkCode: string,
  accessToken: string,
  ranges: GamRange[],
  debug: string[],
): Promise<{ label: string; rows: AttributedRow[] }> {
  const label = "CUSTOM_CRITERIA (key-values da requisição)";
  try {
    const reportRows = (await Promise.all(ranges.map((range) =>
      runReport({ networkCode, accessToken, range, dimensions: ["DATE", "CUSTOM_CRITERIA"], debug })
    ))).flat();
    const rows = rowsFromKeyValueReportRows(reportRows, label);
    debugUtmCandidate(networkCode, label, "utm_campaign+utm_placement", rows, debug);
    return { label, rows };
  } catch (e) {
    debug.push(`[${networkCode}/${label}] erro=${String(e).slice(0, 500)}`);
    return { label, rows: [] };
  }
}

function rowsFromKeyValueReportRows(reportRows: ReportRow[], label: string): AttributedRow[] {
  return reportRows.map((r) => {
    const rawKv = r.dims[1] || r.dims[0] || "";
    const kv = parseKeyValueDimension(rawKv);
    const sourceRaw = kv.utm_source ?? "";
    const campaignRaw = kv.utm_campaign ?? "";
    const placementRaw = kv.utm_placement ?? "";
    const source = safeDecode(sourceRaw).toLowerCase().trim() || "unknown";
    const cid = extractCampaignId(campaignRaw) ?? extractCampaignId(placementRaw);
    const placement = isRealValue(placementRaw) ? extractPlacementValue(placementRaw, cid) : null;
    return {
      date: r.date,
      impressions: r.impressions,
      revenue: r.revenue,
      source,
      cid,
      placement,
      raw: `${label}|utm_source_raw=${sourceRaw || "null"}|utm_campaign_raw=${campaignRaw || "null"}|utm_placement_raw=${placementRaw || "null"}|dim=${label}|raw=${rawKv}`,
    };
  }).filter((r) => r.source !== "unknown" || !!r.cid || !!r.placement);
}

function debugUtmCandidate(networkCode: string, label: string, valueName: string, rows: AttributedRow[], debug: string[]) {
  const sourceStats = rows.reduce((acc: Record<string, { rows: number; rev: number; impr: number; cidOk: number; rawOk: number }>, r) => {
    const s = acc[r.source] ?? { rows: 0, rev: 0, impr: 0, cidOk: 0, rawOk: 0 };
    s.rows++; s.rev += r.revenue; s.impr += r.impressions; if (r.cid) s.cidOk++; if (!r.raw.includes("(not applicable)")) s.rawOk++;
    acc[r.source] = s; return acc;
  }, {});
  const sample = rows.slice(0, 8).map((r) => `${r.raw}|rev=${r.revenue}|cid=${r.cid}|placement=${r.placement}`);
  debug.push(`[${networkCode}/${label}] ${valueName}: linhas=${rows.length}; por_source=${JSON.stringify(sourceStats)}; raw_sample=${JSON.stringify(sample)}`);
}

async function debugKeyValuesName(networkCode: string, accessToken: string, ranges: GamRange[], debug: string[]) {
  try {
    const rows = (await Promise.all(ranges.map((range) =>
      runReport({ networkCode, accessToken, range, dimensions: ["DATE", "KEY_VALUES_NAME"], debug })
    ))).flat();
    const parsed = rows.map((r) => {
      const kv = parseKeyValueDimension(r.dims[1]);
      return { r, kv };
    }).filter(({ kv }) => kv.utm_source || kv.utm_campaign || kv.utm_placement);
    const sample = parsed.slice(0, 10).map(({ r, kv }) => `utm_source=${kv.utm_source ?? "null"}|utm_campaign=${kv.utm_campaign ?? "null"}|utm_placement=${kv.utm_placement ?? "null"}|dim=KEY_VALUES_NAME|raw=${r.dims[1]}|rev=${r.revenue}`);
    debug.push(`[${networkCode}/KEY_VALUES_NAME debug] linhas=${rows.length}; linhas_com_utm=${parsed.length}; sample=${JSON.stringify(sample)}`);
  } catch (e) {
    debug.push(`[${networkCode}/KEY_VALUES_NAME debug] erro=${String(e).slice(0, 500)}`);
  }
}

async function persistCampaignSourceRevenueFromUtm(
  admin: any,
  userId: string,
  siteId: string | undefined,
  rows: AttributedRow[],
  debug: string[],
  syncDates: string[] = [],
) {
  if (!siteId) return;
  const today = new Date().toISOString().slice(0, 10);
  const buckets = new Map<string, { user_id: string; site_id: string; campaign_id: string; date: string; utm_source: string; revenue_usd: number; impressions: number }>();
  for (const r of rows) {
    const date = r.date ?? today;
    const source = (r.source || "unknown").toLowerCase();
    // Quando não conseguimos extrair campaign_id (utm_campaign=(not applicable)),
    // ainda agregamos a receita por source com cid sintético para alimentar a aba Retenção/Push.
    const cid = r.cid ?? "__aggregate__";
    const key = `${cid}|${date}|${source}`;
    const cur = buckets.get(key) ?? {
      user_id: userId, site_id: siteId, campaign_id: cid, date, utm_source: source, revenue_usd: 0, impressions: 0,
    };
    cur.revenue_usd += r.revenue; cur.impressions += r.impressions;
    buckets.set(key, cur);
  }
  const dates = [...new Set([...syncDates, ...[...buckets.values()].map((b) => b.date)])];
  if (dates.length === 0) return;
  await admin.from("gam_campaign_source_revenue")
    .delete().eq("user_id", userId).eq("site_id", siteId).in("date", dates);
  const arr = [...buckets.values()];
  const CHUNK = 500;
  for (let i = 0; i < arr.length; i += CHUNK) {
    await admin.from("gam_campaign_source_revenue").insert(arr.slice(i, i + CHUNK));
  }
  const sources = arr.reduce((acc: Record<string, number>, b) => {
    acc[b.utm_source] = (acc[b.utm_source] ?? 0) + b.revenue_usd; return acc;
  }, {});
  const aggregated = arr.filter((b) => b.campaign_id === "__aggregate__").length;
  debug.push(`[gam_campaign_source_revenue] ${arr.length} linha(s) (${aggregated} agregadas sem cid); receita por source=${JSON.stringify(sources)}`);
}

async function applyGoogleUtmRevenue(
  admin: any,
  userId: string,
  siteId: string | undefined,
  googleCampaignRows: AttributedRow[],
  googlePlacementRows: AttributedRow[],
  fx: FxRates,
  debug: string[],
  syncDates: string[] = [],
) {
  if (!siteId) return;
  const today = new Date().toISOString().slice(0, 10);

  const placementBuckets = new Map<string, { user_id: string; site_id: string; campaign_id: string; placement: string; date: string; revenue_usd: number; impressions: number; source: string; utm_source: string; raw_utm: string }>();
  const directByDateCid = new Map<string, Map<string, { revenue: number; impressions: number }>>();
  const googleTotalByDate = new Map<string, { revenue: number; impressions: number }>();
  for (const r of googleCampaignRows) {
    const date = r.date ?? today;
    if (!r.cid) continue;
    const tot = googleTotalByDate.get(date) ?? { revenue: 0, impressions: 0 };
    tot.revenue += r.revenue; tot.impressions += r.impressions;
    googleTotalByDate.set(date, tot);
    if (!directByDateCid.has(date)) directByDateCid.set(date, new Map());
    const inner = directByDateCid.get(date)!;
    const cur = inner.get(r.cid) ?? { revenue: 0, impressions: 0 };
    cur.revenue += r.revenue; cur.impressions += r.impressions;
    inner.set(r.cid, cur);
  }

  for (const r of googlePlacementRows) {
    if (!r.cid || !r.placement) continue;
    const date = r.date ?? today;
    const key = `${r.cid}|${r.placement}|${date}`;
    const pb = placementBuckets.get(key) ?? {
      user_id: userId, site_id: siteId, campaign_id: r.cid, placement: r.placement,
      date, revenue_usd: 0, impressions: 0, source: "utm_source_google", utm_source: "google", raw_utm: r.raw.slice(0, 500),
    };
    pb.revenue_usd += r.revenue; pb.impressions += r.impressions;
    placementBuckets.set(key, pb);
  }

  const dates = [...new Set([...syncDates, ...[...placementBuckets.values()].map((p) => p.date)])];
  if (dates.length > 0) {
    await admin.from("gam_placement_revenue")
      .delete().eq("user_id", userId).eq("site_id", siteId).in("date", dates);
    const arr = [...placementBuckets.values()];
    const CHUNK = 500;
    for (let i = 0; i < arr.length; i += CHUNK) {
      await admin.from("gam_placement_revenue").insert(arr.slice(i, i + CHUNK));
    }
    debug.push(`[gam_placement_revenue] ${arr.length} linha(s) gravadas (apenas utm_source=google)`);
  }

  const { data: links } = await admin
    .from("account_site_links")
    .select("google_account_id")
    .eq("user_id", userId)
    .eq("site_id", siteId);
  const accountIds = (links ?? []).map((l: any) => l.google_account_id).filter(Boolean);
  if (accountIds.length === 0) {
    debug.push(`[daily_metrics] sem vínculo Ads↔site`);
    return;
  }

  const allDates = new Set<string>([...syncDates, ...directByDateCid.keys(), ...googleTotalByDate.keys()]);
  for (const date of allDates) {
    const { data: metrics } = await admin
      .from("daily_metrics")
      .select("id, campaign_id, spend, impressions")
      .eq("user_id", userId)
      .eq("date", date)
      .in("google_account_id", accountIds);
    if (!metrics?.length) continue;

    const directMap = directByDateCid.get(date) ?? new Map();
    const matchedIds = new Set<string>();
    const totalGoogle = googleTotalByDate.get(date) ?? { revenue: 0, impressions: 0 };
    let attributedRev = 0;
    for (const v of directMap.values()) attributedRev += (v as any).revenue;

    const updates: any[] = [];
    for (const m of metrics as any[]) {
      const direct = directMap.get(String(m.campaign_id));
      let revenueUsd = direct?.revenue ?? 0;
      if (direct) matchedIds.add(String(m.campaign_id));
      const spendBrl = Number(m.spend ?? 0);
      const revenueBrl = revenueUsd * fx.usdBrl;
      const impressions = Number(m.impressions ?? 0);
      const profit = revenueBrl - spendBrl;
      const roi = spendBrl > 0 ? (profit / spendBrl) * 100 : 0;
      const roas = spendBrl > 0 ? revenueBrl / spendBrl : 0;
      const ecpm = impressions > 0 ? (revenueBrl / impressions) * 1000 : 0;
      updates.push({ id: m.id, revenue: revenueUsd, profit, roi, roas, ecpm });
    }
    const CHUNK = 25;
    for (let i = 0; i < updates.length; i += CHUNK) {
      await Promise.all(
        updates.slice(i, i + CHUNK).map((u) =>
          admin.from("daily_metrics").update({
            revenue: u.revenue, profit: u.profit, roi: u.roi, roas: u.roas, ecpm: u.ecpm,
          }).eq("id", u.id)
        ),
      );
    }
    debug.push(`[daily_metrics] ${date}: ${matchedIds.size} match UTM Google real; total atribuído=$${attributedRev.toFixed(2)} de total Google com campaign_id=$${totalGoogle.revenue.toFixed(2)}; sem fallback por gasto`);
  }
}

interface RunReportArgs {
  networkCode: string;
  accessToken: string;
  range: GamRange;
  dimensions: string[];
  dimensionKeyIds?: string[];
  dimensionKeyIdsField?: "customDimensionKeyIds" | "ekvDimensionKeyIds";
  debug: string[];
}

async function runReport(args: RunReportArgs): Promise<ReportRow[]> {
  const { networkCode, accessToken, range, dimensions, dimensionKeyIds, dimensionKeyIdsField, debug } = args;
  const tag = `${networkCode}/${dimensions.join("+")}`;

  const reportDefinition: any = {
    reportType: "HISTORICAL",
    dimensions,
    metrics: [
      "AD_SERVER_IMPRESSIONS",
      "AD_SERVER_REVENUE",
      "AD_EXCHANGE_IMPRESSIONS",
      "AD_EXCHANGE_REVENUE",
      "ADSENSE_IMPRESSIONS",
      "ADSENSE_REVENUE",
    ],
    dateRange: range.dateRange,
  };
  if (dimensionKeyIds?.length) reportDefinition[dimensionKeyIdsField ?? "customDimensionKeyIds"] = dimensionKeyIds;

  const reportBody = { visibility: "DRAFT", reportDefinition };
  const createRes = await fetch(`${GAM_BASE}/networks/${networkCode}/reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(reportBody),
  });
  const createText = await createRes.text();
  debug.push(`[${tag}] create status=${createRes.status}`);
  let createJson: any;
  try { createJson = JSON.parse(createText); }
  catch {
    throw new Error(
      "Google Ad Manager API não está habilitada no projeto do Google Cloud da Service Account. Acesse https://console.cloud.google.com/apis/library/admanager.googleapis.com, selecione o projeto correto e clique em ENABLE."
    );
  }
  if (!createRes.ok) throw new Error(`[${tag}] create failed (${createRes.status}): ${createText.slice(0, 400)}`);
  const reportName: string = createJson.name;

  const runRes = await fetch(`${GAM_BASE}/${reportName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const runJson = await parseJsonResponse(runRes, "run report", tag);
  if (!runRes.ok) throw new Error(`[${tag}] run failed: ${JSON.stringify(runJson)}`);
  const opName: string = runJson.name;

  let resultName: string | null = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const opRes = await fetch(`${GAM_BASE}/${opName}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const opJson = await parseJsonResponse(opRes, "poll", tag);
    if (opJson.done) {
      if (opJson.error) throw new Error(`[${tag}] op error: ${JSON.stringify(opJson.error)}`);
      resultName = opJson.response?.reportResult?.name ?? opJson.response?.reportResult ?? opJson.response?.name;
      if (!resultName) throw new Error(`[${tag}] report done sem reportResult`);
      debug.push(`[${tag}] done after ${(i + 1) * 2}s`);
      break;
    }
  }
  if (!resultName) throw new Error(`[${tag}] report timeout`);

  const allRows: ReportRow[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    const rowsRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const rowsJson = await parseJsonResponse(rowsRes, "fetchRows", tag);
    if (!rowsRes.ok) throw new Error(`[${tag}] fetchRows failed: ${JSON.stringify(rowsJson)}`);

    const rows = (rowsJson.rows ?? []) as Array<{
      dimensionValues?: Array<{ stringValue?: string; intValue?: string }>;
      metricValueGroups?: Array<{ primaryValues?: Array<{ intValue?: string; doubleValue?: number }> }>;
    }>;
    for (const r of rows) {
      const dimsVals = r.dimensionValues ?? [];
      const date = parseGamDate(dimsVals[0]);
      const dimStrings = dimsVals.slice(0).map((d) => d?.stringValue ?? d?.intValue ?? "");
      const m = r.metricValueGroups?.[0]?.primaryValues ?? [];
      const num = (v: any) => Number(v?.intValue ?? v?.doubleValue ?? 0);
      const impressions = num(m[0]) + num(m[2]) + num(m[4]);
      const revenue = normalizeGamRevenue(num(m[1])) + normalizeGamRevenue(num(m[3])) + normalizeGamRevenue(num(m[5]));
      allRows.push({ date, dims: dimStrings, impressions, revenue });
    }
    pageToken = rowsJson.nextPageToken;
  } while (pageToken);

  return allRows;
}

function normalizeGamRevenue(value: number) {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Math.abs(value) >= 1_000 ? value / 1_000_000 : value;
}

function parseGamDate(value: any): string | null {
  const raw = String(value?.stringValue ?? value?.intValue ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return null;
}

async function parseJsonResponse(res: Response, step: string, tag: string) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`[${tag}] ${step} retornou resposta não-JSON (status ${res.status}): ${preview}`);
  }
}

// JWT auth para service account
async function getAccessToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const pem = sa.private_key.replace(/\\n/g, "\n");
  const pkcs8 = pemToArrayBuffer(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8", pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${unsigned}.${sigB64}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
  return j.access_token as string;
}

function pemToArrayBuffer(pem: string) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function formatGamError(status: number, payload: any) {
  const reason = payload?.error?.details?.find((d: any) => d?.reason)?.reason;
  if (status === 401 || reason === "AUTH_ERROR_AUTHENTICATION_FAILED") {
    return "GAM não autenticou a Service Account. No Google Ad Manager, adicione o email da Service Account como usuário da rede e libere permissão para ver/executar relatórios; se estiver pendente, aprove o usuário antes de sincronizar.";
  }
  return `create report failed: ${JSON.stringify(payload)}`;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
