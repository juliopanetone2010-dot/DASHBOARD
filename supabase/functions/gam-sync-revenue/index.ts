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
        const adUnitRows = (await Promise.all(ranges.map((range) => runReport(networkCode, accessToken, range, "AD_UNIT_NAME", debug)))).flat();
        const placementRows = (await Promise.all(ranges.map((range) => runReport(networkCode, accessToken, range, "PLACEMENT_NAME", debug)))).flat();
        let googleUtmRows: ReportRow[] = [];
        let customCriteriaAvailable = false;
        try {
          const customCriteriaRows = (await Promise.all(ranges.map((range) => runReport(networkCode, accessToken, range, "AD_REQUEST_CUSTOM_CRITERIA", debug))))
            .flat()
          customCriteriaAvailable = true;
          googleUtmRows = customCriteriaRows.filter((r) => parseGamAttribution(r.name)?.source === "google");
          const otherUtmRows = customCriteriaRows.filter((r) => {
            const parsed = parseGamAttribution(r.name);
            return parsed?.source && parsed.source !== "google";
          }).length;
          debug.push(`[${networkCode}/AD_REQUEST_CUSTOM_CRITERIA] google utm rows=${googleUtmRows.length}; outras origens UTM ignoradas=${otherUtmRows}`);
        } catch (e) {
          debug.push(`[${networkCode}/AD_REQUEST_CUSTOM_CRITERIA] indisponível: ${String(e)}`);
        }

        // Para ROI de Ads, só usamos receita com utm_source=google. Receita de push/retenção
        // ou tráfego sem UTM não pode ser rateada em campanhas/placements do Google Ads.
        const canonicalRows = customCriteriaAvailable ? googleUtmRows : [];
        const totals = canonicalRows.reduce(
          (acc, r) => ({
            revenue: acc.revenue + r.revenue,
            impressions: acc.impressions + r.impressions,
          }),
          { revenue: 0, impressions: 0 },
        );
        const today = new Date().toISOString().slice(0, 10);

        // Persiste rows como placements em bulk (chunked upsert)
        const persistRows = async (rows: ReportRow[], kind: "ad_unit" | "placement") => {
          if (rows.length === 0) return;
          const siteForRow = networkSites[0];
          const payload = rows.map((r) => {
            const ecpm = r.impressions > 0 ? (r.revenue / r.impressions) * 1000 : 0;
            return {
              user_id: userId,
              site_id: siteForRow.id,
              site: siteForRow.name,
              ad_unit: kind === "ad_unit" ? r.name : null,
              placement_key: `${kind}:${networkCode}:${r.name}`,
              date: r.date ?? today,
              impressions: r.impressions,
              revenue: r.revenue,
              ecpm,
            };
          });
          const CHUNK = 500;
          for (let i = 0; i < payload.length; i += CHUNK) {
            await admin.from("placements").upsert(
              payload.slice(i, i + CHUNK),
              { onConflict: "user_id,placement_key,date" },
            );
          }
        };

        if (!testMode) {
          await persistRows(adUnitRows, "ad_unit");
          await persistRows(placementRows, "placement");
          await distributeGamRevenueToCampaigns(admin, userId, networkSites[0]?.id, canonicalRows, fxRates, debug, requestedAccountIds);
        }

        summary.push({
          network_code: networkCode,
          sites: networkSites.map((s) => s.name),
          ad_unit_rows: adUnitRows.length,
          placement_rows: placementRows.length,
          custom_criteria_rows: googleUtmRows.length,
          custom_criteria_available: customCriteriaAvailable,
          attribution_rule: "utm_source=google only",
          currency: "USD",
          usd_brl_rate: fxRates.usdBrl,
          total_revenue_usd: totals.revenue,
          total_impressions: totals.impressions,
          date_range: ranges.map((r) => r.debugLabel),
          site_id: requestedSiteId ?? null,
          rows_returned: canonicalRows.length,
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

interface ReportRow { date: string | null; name: string; impressions: number; revenue: number; }

interface FxRates { usdBrl: number; }

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

function dateObj(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

// Extrai (campaign_id, placement) do nome do ad unit/placement do GAM.
// Padrão UTM: utm_placement={campaignid}_{placement}
// Exemplo: "23389421643_afrisearch.com" → { cid: "23389421643", placement: "afrisearch.com" }
function extractCampaignIdFromName(name: string): string | null {
  return parseGamPlacementName(name)?.cid ?? null;
}

function parseGamPlacementName(name: string): { cid: string; placement: string } | null {
  if (!name) return null;
  const decoded = safeDecode(String(name).trim());
  const utm = decoded.match(/(?:^|[\s,;|])utm_placement[=~*]*([^\s,;|]+)/i);
  const candidate = utm?.[1] ?? decoded;
  const m = candidate.match(/(\d{6,})[_\-:](.+)$/);
  if (!m) return null;
  return { cid: m[1], placement: normalizePlacement(m[2]) };
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function normalizePlacement(s: string): string {
  const t = (s || "").trim().toLowerCase();
  // App
  const appMatch = t.match(/mobileapp::\d+-(.+)$/i);
  if (appMatch) return appMatch[1];
  try {
    const u = new URL(t.startsWith("http") ? t : `https://${t}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return t.replace(/^www\./, "");
  }
}

async function distributeGamRevenueToCampaigns(
  admin: any,
  userId: string,
  siteId: string | undefined,
  rows: ReportRow[],
  _fx: FxRates,
  debug: string[],
  requestedAccountIds: string[] = [],
) {
  if (!siteId || rows.length === 0) return;

  // Agrupa por (date, campaign_id_extraido) — match direto via UTM quando possível.
  const today = new Date().toISOString().slice(0, 10);
  const directByDateCid = new Map<string, Map<string, { revenue: number; impressions: number }>>();
  const unmatchedByDate = new Map<string, { revenue: number; impressions: number }>();
  // Atribuição por (campaign_id, placement, date) — para a tabela gam_placement_revenue
  const placementBuckets = new Map<string, { user_id: string; site_id: string; campaign_id: string; placement: string; date: string; revenue_usd: number; impressions: number; source: string }>();
  for (const r of rows) {
    const date = r.date ?? today;
    const parsed = parseGamPlacementName(r.name);
    if (parsed) {
      const cid = parsed.cid;
      if (!directByDateCid.has(date)) directByDateCid.set(date, new Map());
      const inner = directByDateCid.get(date)!;
      const cur = inner.get(cid) ?? { revenue: 0, impressions: 0 };
      cur.revenue += r.revenue; cur.impressions += r.impressions;
      inner.set(cid, cur);

      const key = `${cid}|${parsed.placement}|${date}`;
      const pb = placementBuckets.get(key) ?? {
        user_id: userId, site_id: siteId, campaign_id: cid, placement: parsed.placement,
        date, revenue_usd: 0, impressions: 0, source: "utm_name",
      };
      pb.revenue_usd += r.revenue; pb.impressions += r.impressions;
      placementBuckets.set(key, pb);
    } else {
      const cur = unmatchedByDate.get(date) ?? { revenue: 0, impressions: 0 };
      cur.revenue += r.revenue; cur.impressions += r.impressions;
      unmatchedByDate.set(date, cur);
    }
  }

  // Persiste atribuição por placement (substitui período)
  if (placementBuckets.size > 0) {
    const dates = [...new Set([...placementBuckets.values()].map((p) => p.date))];
    await admin.from("gam_placement_revenue")
      .delete().eq("user_id", userId).in("date", dates);
    const arr = [...placementBuckets.values()];
    const CHUNK = 500;
    for (let i = 0; i < arr.length; i += CHUNK) {
      await admin.from("gam_placement_revenue").insert(arr.slice(i, i + CHUNK));
    }
    debug.push(`[gam_placement_revenue] ${arr.length} linha(s) gravadas`);
  }

  const { data: links, error: linksErr } = await admin
    .from("account_site_links")
    .select("google_account_id")
    .eq("user_id", userId)
    .eq("site_id", siteId);
  if (linksErr || !links?.length) {
    debug.push(`[daily_metrics] sem vínculo Ads↔site para distribuir receita GAM`);
    return;
  }
  // IMPORTANTE: a receita do GAM é total do site — sempre distribuímos entre TODAS as
  // contas Ads vinculadas ao site, independente do filtro de UI. Filtrar aqui causaria
  // receita "vazando" para outras contas via leftover.
  const accountIds = links.map((l: any) => l.google_account_id).filter(Boolean);
  if (accountIds.length === 0) {
    debug.push(`[daily_metrics] nenhuma conta Ads vinculada ao site`);
    return;
  }

  const allDates = new Set<string>([...directByDateCid.keys(), ...unmatchedByDate.keys()]);
  for (const date of allDates) {
    const { data: metrics, error: metricsErr } = await admin
      .from("daily_metrics")
      .select("id, campaign_id, spend, impressions")
      .eq("user_id", userId)
      .eq("date", date)
      .in("google_account_id", accountIds);
    if (metricsErr || !metrics?.length) {
      debug.push(`[daily_metrics] sem campanhas Ads em ${date}`);
      continue;
    }

    // 1) match direto via UTM
    const directMap = directByDateCid.get(date) ?? new Map();
    const matchedIds = new Set<string>();
    const revenueByMetricId = new Map<string, number>();
    for (const m of metrics as any[]) {
      const direct = directMap.get(String(m.campaign_id));
      if (direct) {
        revenueByMetricId.set(m.id, (revenueByMetricId.get(m.id) ?? 0) + direct.revenue);
        matchedIds.add(String(m.campaign_id));
      }
    }
    // 2) sobra: receita não-matchada + receita de cids do GAM sem campanha Ads correspondente
    let leftover = unmatchedByDate.get(date)?.revenue ?? 0;
    for (const [cid, v] of directMap) {
      if (!matchedIds.has(cid)) leftover += v.revenue;
    }
    if (leftover > 0) {
      const totalImp = metrics.reduce((acc: number, m: any) => acc + Math.max(Number(m.impressions ?? 0), 0), 0) || metrics.length;
      for (const m of metrics as any[]) {
        const w = totalImp === metrics.length ? 1 : Math.max(Number(m.impressions ?? 0), 0);
        const share = (w / totalImp) * leftover;
        revenueByMetricId.set(m.id, (revenueByMetricId.get(m.id) ?? 0) + share);
      }
    }

    const updates: any[] = [];
    for (const m of metrics as any[]) {
      const revenueUsd = revenueByMetricId.get(m.id) ?? 0;
      const spendBrl = Number(m.spend ?? 0);
      const revenueBrl = revenueUsd * _fx.usdBrl;
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
    debug.push(`[daily_metrics] ${date}: ${matchedIds.size} match direto via UTM, leftover ${leftover.toFixed(4)} USD rateado em ${metrics.length} campanha(s)`);
  }
}

async function runReport(
  networkCode: string,
  accessToken: string,
  range: GamRange,
  groupDim: "AD_UNIT_NAME" | "PLACEMENT_NAME" | "AD_REQUEST_CUSTOM_CRITERIA",
  debug: string[],
): Promise<ReportRow[]> {
  // 1) cria report
  const reportBody = {
    visibility: "DRAFT",
    reportDefinition: {
      reportType: "HISTORICAL",
      dimensions: ["DATE", groupDim],
      metrics: [
        "AD_SERVER_IMPRESSIONS",
        "AD_SERVER_REVENUE",
        "AD_EXCHANGE_IMPRESSIONS",
        "AD_EXCHANGE_REVENUE",
        "ADSENSE_IMPRESSIONS",
        "ADSENSE_REVENUE",
      ],
      dateRange: range.dateRange,
    },
  };
  const createRes = await fetch(
    `${GAM_BASE}/networks/${networkCode}/reports`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reportBody),
    },
  );
  const createText = await createRes.text();
  debug.push(`[${networkCode}/${groupDim}] create status=${createRes.status}`);
  let createJson: any;
  try { createJson = JSON.parse(createText); }
  catch {
    throw new Error(
      "Google Ad Manager API não está habilitada no projeto do Google Cloud da Service Account. Acesse https://console.cloud.google.com/apis/library/admanager.googleapis.com, selecione o projeto correto e clique em ENABLE. Depois aguarde ~1 min e sincronize novamente."
    );
  }
  if (!createRes.ok) throw new Error(formatGamError(createRes.status, createJson));
  const reportName: string = createJson.name; // networks/X/reports/Y

  // 2) run report (LRO)
  const runRes = await fetch(`${GAM_BASE}/${reportName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const runJson = await parseJsonResponse(runRes, "run report", networkCode, groupDim);
  debug.push(`[${networkCode}/${groupDim}] run status=${runRes.status}`);
  if (!runRes.ok) throw new Error(`run failed: ${JSON.stringify(runJson)}`);
  const opName: string = runJson.name; // operations/...

  // 3) poll operation até done
  let resultName: string | null = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const opRes = await fetch(`${GAM_BASE}/${opName}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const opJson = await parseJsonResponse(opRes, "poll operation", networkCode, groupDim);
    if (opJson.done) {
      if (opJson.error) throw new Error(`op error: ${JSON.stringify(opJson.error)}`);
      resultName = opJson.response?.reportResult?.name ?? opJson.response?.reportResult ?? opJson.response?.name;
      if (!resultName) throw new Error(`report done sem reportResult: ${JSON.stringify(opJson.response ?? opJson)}`);
      debug.push(`[${networkCode}/${groupDim}] done after ${(i + 1) * 2}s`);
      debug.push(`[${networkCode}/${groupDim}] result=${resultName}`);
      break;
    }
  }
  if (!resultName) throw new Error("report timeout");

  // 4) fetch result rows
  const allRows: ReportRow[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    const rowsRes = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    debug.push(`[${networkCode}/${groupDim}] fetchRows status=${rowsRes.status}`);
    const rowsJson = await parseJsonResponse(rowsRes, "fetchRows", networkCode, groupDim);
    if (!rowsRes.ok) throw new Error(`fetchRows failed: ${JSON.stringify(rowsJson)}`);

    const rows = (rowsJson.rows ?? []) as Array<{
      dimensionValues?: Array<{ stringValue?: string; intValue?: string }>;
      metricValueGroups?: Array<{
        primaryValues?: Array<{ intValue?: string; doubleValue?: number }>;
      }>;
    }>;

    for (const r of rows) {
      const dims = r.dimensionValues ?? [];
      const date = parseGamDate(dims[0]);
      const name = dims[1]?.stringValue ?? "(unknown)";
      const m = r.metricValueGroups?.[0]?.primaryValues ?? [];
      const num = (v: any) => Number(v?.intValue ?? v?.doubleValue ?? 0);
      // Impressões: AdServer + AdExchange + AdSense
      const impressions = num(m[0]) + num(m[2]) + num(m[4]);
      // A API nova do GAM pode retornar receita já em decimal USD ou em micros,
      // dependendo do backend/metric. Normalizamos sem dividir duas vezes.
      const revenue = normalizeGamRevenue(num(m[1])) + normalizeGamRevenue(num(m[3])) + normalizeGamRevenue(num(m[5]));
      allRows.push({ date, name, impressions, revenue });
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

async function parseJsonResponse(
  res: Response,
  step: string,
  networkCode: string,
  groupDim: string,
) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(
      `[${networkCode}/${groupDim}] ${step} retornou resposta não-JSON (status ${res.status}, content-type ${res.headers.get("content-type") ?? "sem content-type"}): ${preview}`,
    );
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
