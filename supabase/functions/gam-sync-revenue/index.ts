// Sincroniza receita do Google Ad Manager (REST API v1 beta)
// - Autentica via JWT (service account)
// - Roda 2 reports: por AD_UNIT_NAME e por PLACEMENT_NAME
// - Faz upsert em `placements` e atualiza `revenue/impressions/ecpm`
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";
const ALLOWED_PRESETS = new Set(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS"]);

// Semáforo global: serializa TODAS as chamadas HTTP ao GAM dentro desta invocação
// para evitar estourar a quota (429). Pequeno jitter entre chamadas reduz bursts.
let gamQueue: Promise<unknown> = Promise.resolve();
const GAM_MIN_INTERVAL_MS = 350;
let lastGamCallAt = 0;
async function gamFetch(input: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  if (attempt === 0) {
    const prev = gamQueue;
    let release: () => void = () => {};
    gamQueue = new Promise<void>((r) => (release = r));
    try {
      await prev;
      const since = Date.now() - lastGamCallAt;
      if (since < GAM_MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, GAM_MIN_INTERVAL_MS - since));
      lastGamCallAt = Date.now();
      return await gamFetchRaw(input, init, 0);
    } finally {
      release();
    }
  }
  return gamFetchRaw(input, init, attempt);
}
async function gamFetchRaw(input: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(input, init);
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    const backoff = retryAfter > 0 ? retryAfter * 1000 : [3000, 8000, 20000, 45000][attempt];
    console.warn(`[gam-sync-revenue] ${res.status} — backoff ${backoff}ms (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, backoff));
    return gamFetchRaw(input, init, attempt + 1);
  }
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const control = await req.clone().json().catch(() => ({}));
  if (control?.wait === true || control?.sync === true) {
    return await runSync(req);
  }

  // Roda o trabalho pesado em background para evitar WORKER_RESOURCE_LIMIT (CPU/wall time)
  const work = runSync(req).catch((e) => console.error("[gam-sync-revenue] background error", e));
  // @ts-ignore EdgeRuntime is available in Supabase edge runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work);
  }
  // Retorna 200 (não 202) porque supabase-js trata qualquer não-200 como erro.
  return new Response(JSON.stringify({ ok: true, status: "started", message: "Sincronização iniciada em background. Atualize a página em ~2 min." }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

async function runSync(req: Request): Promise<Response> {
  const debug: string[] = [];
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });


    let datePreset = "LAST_7_DAYS";
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    let requestedSiteId: string | null = null;
    let requestedAccountIds: string[] = [];
    let requestedUserId: string | null = null;
    let includeYesterdayFallback = false;
    let testMode = false;
    let revenueOnly = true;
    let skipLegacyReports = true;
    let skipViewability = false;
    let skipSnapshotRegen = false;
    const startedAt = Date.now();
    const deadlineAt = startedAt + 115_000;
    const hasBudget = (minimumMs = 20_000) => Date.now() + minimumMs < deadlineAt;
    try {
      const body = await req.json().catch(() => ({}));
      const p = String((body as any)?.date_preset ?? "").toUpperCase();
      if (ALLOWED_PRESETS.has(p)) datePreset = p;
      dateFrom = typeof (body as any)?.from === "string" ? (body as any).from : null;
      dateTo = typeof (body as any)?.to === "string" ? (body as any).to : null;
      requestedSiteId = typeof (body as any)?.site_id === "string" ? (body as any).site_id : null;
      requestedUserId = typeof (body as any)?.user_id === "string" ? (body as any).user_id : null;
      requestedAccountIds = Array.isArray((body as any)?.account_ids)
        ? (body as any).account_ids.filter((id: unknown) => typeof id === "string" && id.length > 0)
        : [];
      includeYesterdayFallback = Boolean((body as any)?.include_yesterday_fallback);
      testMode = Boolean((body as any)?.test);
      const includeFullReports = Boolean((body as any)?.include_full_reports);
      revenueOnly = !includeFullReports || Boolean((body as any)?.revenue_only) || String((body as any)?.mode ?? "").toLowerCase() === "revenue";
      skipLegacyReports = revenueOnly || Boolean((body as any)?.skip_legacy_reports);
      // Viewability/eCPM diário (site_metrics_daily) é leve (só dimensão DATE) e crítico para o dashboard.
      // Só pula se cliente pedir EXPLICITAMENTE — não atrelar ao revenue_only.
      skipViewability = Boolean((body as any)?.skip_viewability);
      skipSnapshotRegen = Boolean((body as any)?.skip_snapshot_regen);
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
    const token = authHeader.replace("Bearer ", "");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    let userId: string | undefined;
    if (token && serviceRoleKey && token === serviceRoleKey) {
      // Chamada interna (cron/snapshot): usa user_id passado no body
      userId = requestedUserId ?? undefined;
    } else {
      const { data: claims } = await userClient.auth.getClaims(token);
      userId = claims?.claims?.sub;
    }
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let sitesQuery = admin
      .from("sites")
      .select("id, name, domain, network_code, gam_currency, gam_currency_override")
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

        // Auto-detect Network currency (respeita override manual)
        const detectedCurrency = await fetchNetworkCurrency(networkCode, accessToken, debug);
        if (detectedCurrency) {
          for (const s of networkSites) {
            if (!(s as any).gam_currency_override && String((s as any).gam_currency ?? "USD").toUpperCase() !== detectedCurrency) {
              await admin.from("sites").update({
                gam_currency: detectedCurrency,
                gam_currency_detected_at: new Date().toISOString(),
              }).eq("id", s.id);
              (s as any).gam_currency = detectedCurrency;
              debug.push(`[currency] site=${s.name} updated → ${detectedCurrency}`);
            } else if (!(s as any).gam_currency_override) {
              await admin.from("sites").update({
                gam_currency_detected_at: new Date().toISOString(),
              }).eq("id", s.id);
            }
          }
        }

        // Reports legados (ad unit + placement) são pesados e não entram no ROI.
        // Em sincronizações automáticas usamos revenue_only para evitar timeout de 150s.
        let adUnitRows: Array<ReportRow & { name: string }> = [];
        let placementRows: Array<ReportRow & { name: string }> = [];
        if (!skipLegacyReports && hasBudget(45_000)) {
          adUnitRows = (await Promise.all(ranges.map((range) =>
            runReport({ networkCode, accessToken, range, dimensions: ["DATE", "AD_UNIT_NAME"], debug, deadlineAt })
          ))).flat().map((r) => ({ ...r, name: r.dims[1] ?? "(unknown)" }));
          placementRows = (await Promise.all(ranges.map((range) =>
            runReport({ networkCode, accessToken, range, dimensions: ["DATE", "PLACEMENT_NAME"], debug, deadlineAt })
          ))).flat().map((r) => ({ ...r, name: r.dims[1] ?? "(unknown)" }));
        } else {
          debug.push(`[${networkCode}] legacy placement/ad-unit reports skipped (revenue_only=${revenueOnly})`);
        }

        // Não precisamos mais descobrir IDs de custom targeting keys.
        // CUSTOM_CRITERIA traz a string crua das key-values, então parseamos diretamente.
        const utmKeyIds: UtmKeyIds = { utm_source: null, utm_campaign: null, utm_placement: null };
        const attribution = await collectUtmAttribution({ networkCode, accessToken, ranges, utmKeyIds, debug, deadlineAt, fastMode: revenueOnly });
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

        const siteCurrency = String((networkSites[0] as any)?.gam_currency ?? "USD").toUpperCase();
        // Quando o GAM do site reporta em BRL nativo, normalizamos para "USD-equivalente"
        // dividindo por FX antes de gravar — assim todo o app downstream (que multiplica por FX
        // para exibir em BRL) continua correto, sem dupla conversão.
        const ingestionDivisor = siteCurrency === "BRL" ? (fxRates.usdBrl || 1) : 1;

        // Viewability + eCPM por site/dia (report dedicado, separado de revenue para evitar rejeição do GAM)
        let viewabilityRows: Array<{ date: string | null; impressions: number; measurable: number; viewable: number; revenue: number }> = [];
        let viewabilityError: string | null = null;
        // Tenta múltiplos conjuntos de métricas — o GAM aceita prefixos diferentes
        // (AD_SERVER_, AD_EXCHANGE_) dependendo do tipo de inventário do site.
        // Combinamos os dois para cobrir Ad Server direto + Ad Exchange.
        const viewabilityVariants: Array<{ label: string; metrics: string[] }> = [
          {
            label: "AD_SERVER",
            metrics: [
              "AD_SERVER_IMPRESSIONS",
              "AD_SERVER_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS",
              "AD_SERVER_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS",
              "AD_SERVER_REVENUE",
            ],
          },
          {
            label: "AD_EXCHANGE",
            metrics: [
              "AD_EXCHANGE_IMPRESSIONS",
              "AD_EXCHANGE_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS",
              "AD_EXCHANGE_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS",
              "AD_EXCHANGE_REVENUE",
            ],
          },
        ];
        const aggMap = new Map<string, { impr: number; meas: number; view: number; rev: number }>();
        if (skipViewability || !hasBudget(35_000)) {
          debug.push(`[${networkCode}] viewability skipped (revenue_only=${revenueOnly})`);
        } else for (const variant of viewabilityVariants) {
          try {
            const raw = (await Promise.all(ranges.map((range) =>
              runReport({ networkCode, accessToken, range, dimensions: ["DATE"], metrics: variant.metrics, debug, deadlineAt })
            ))).flat();
            debug.push(`[${networkCode}] viewability ${variant.label} rows=${raw.length}`);
            for (const r of raw as any[]) {
              const key = r.date ?? "_";
              const cur = aggMap.get(key) ?? { impr: 0, meas: 0, view: 0, rev: 0 };
              cur.impr += Number(r.impressions ?? 0);
              cur.meas += Number(r._raw_measurable ?? 0);
              cur.view += Number(r._raw_viewable ?? 0);
              cur.rev += Number(r.revenue ?? 0);
              aggMap.set(key, cur);
            }
          } catch (e) {
            const msg = String(e).slice(0, 200);
            viewabilityError = msg;
            debug.push(`[${networkCode}] viewability ${variant.label} falhou: ${msg}`);
          }
        }
        viewabilityRows = [...aggMap.entries()].map(([d, v]) => ({
          date: d === "_" ? null : d,
          impressions: v.impr, measurable: v.meas, viewable: v.view, revenue: v.rev,
        }));


        if (!testMode) {
          await persistRows(adUnitRows, "ad_unit");
          await persistRows(placementRows, "placement");
          await persistCampaignSourceRevenueFromUtm(admin, userId, networkSites[0]?.id, [...utmRows, ...googleCampaignRows], debug, expandFixedDates(ranges), ingestionDivisor);
          await applyGoogleUtmRevenue(admin, userId, networkSites[0]?.id, googleCampaignRows, googlePlacementRows, fxRates, debug, expandFixedDates(ranges), ingestionDivisor, siteCurrency);
          await persistSiteMetricsDaily(admin, userId, networkSites[0]?.id, siteCurrency, viewabilityRows, debug);
          for (const site of networkSites) {
            try {
              await persistGamUrlRevenue({
                admin, userId, siteId: site?.id, siteDomain: site?.domain,
                networkCode, accessToken, ranges, debug, ingestionDivisor,
                allowRelativeUrls: networkSites.length === 1,
              });
            } catch (e) {
              debug.push(`[${networkCode}] persistGamUrlRevenue site=${site?.domain ?? site?.id} erro: ${String(e).slice(0, 300)}`);
            }
          }
        }

        const vTot = viewabilityRows.reduce((a, r) => ({
          impr: a.impr + r.impressions, meas: a.meas + r.measurable, view: a.view + r.viewable, rev: a.rev + r.revenue,
        }), { impr: 0, meas: 0, view: 0, rev: 0 });
        const viewabilityPct = vTot.meas > 0 ? (vTot.view / vTot.meas) * 100 : 0;
        const ecpmNative = vTot.impr > 0 ? (vTot.rev / vTot.impr) * 1000 : 0;

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
          revenue_only: revenueOnly,
          currency: siteCurrency,
          detected_currency: detectedCurrency ?? null,
          usd_brl_rate: fxRates.usdBrl,
          total_revenue_usd: totals.revenue,
          total_impressions: totals.impressions,
          viewability_pct: viewabilityPct,
          ecpm_native: ecpmNative,
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

    // Re-gera os snapshots financeiros dos dias sincronizados, para que o calendário
    // sempre reflita a receita GAM mais recente (evita defasagem como 06/05 ficar com R$ 39 quando o GAM já tinha R$ 76).
    try {
      if (skipSnapshotRegen) {
        debug.push("[snapshot] regen skipped by caller");
      } else {
      const allDates = Array.from(new Set(
        summary.flatMap((s) => Array.isArray(s.date_range)
          ? (s.date_range as string[]).flatMap((label) => label.split("..").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))
          : []),
      ));
      // Expande ranges X..Y em datas individuais
      const expanded = new Set<string>();
      for (const lbl of allDates) expanded.add(lbl);
      for (const s of summary) {
        if (!Array.isArray(s.date_range)) continue;
        for (const lbl of s.date_range as string[]) {
          const m = String(lbl).match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
          if (m) {
            const a = new Date(m[1] + "T00:00:00Z"); const b = new Date(m[2] + "T00:00:00Z");
            for (const d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
              expanded.add(d.toISOString().slice(0, 10));
            }
          }
        }
      }
      for (const d of expanded) {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-daily-snapshot`, {
          method: "POST",
          headers: {
            Authorization: authHeader!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ date: d, site_id: requestedSiteId ?? null }),
        }).catch(() => {});
      }
      debug.push(`[snapshot] regenerated ${expanded.size} day(s)`);
      }
    } catch (e) {
      debug.push(`[snapshot] regen failed: ${String(e)}`);
    }

    return json({ ok: true, date_preset: datePreset, summary, gam_debug: gamDebug, debug });
  } catch (e) {
    console.error("[gam-sync-revenue] uncaught", e);
    return json({ error: String(e), debug });
  }
}

interface ReportRow { date: string | null; dims: string[]; impressions: number; revenue: number; _raw_measurable?: number; _raw_viewable?: number; }
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
  // GAM CUSTOM_CRITERIA vem como: "utm_source=google;utm_campaign=23389421643;utm_placement=23389421643_as_diariovagas_mob_top"
  // Pode ter variações: separador ; , & ou \n; valor pode vir prefixado com * (negativos) ou ter |
  const out: Record<string, string> = {};
  const decoded = safeDecode(String(raw ?? ""));
  const normalized = decoded.replace(/[\n\r;]+/g, ",").replace(/&/g, ",");
  for (const part of normalized.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // aceita = ou ~ como separador key/value (GAM usa ~ em alguns formatos legados)
    const m = trimmed.match(/^([^=~|]+)[=~](.+)$/);
    if (!m) continue;
    const key = m[1].replace(/^\*/, "").replace(/^custom targeting\s*/i, "").trim().toLowerCase();
    const value = m[2].split("|")[0]?.replace(/^\*/, "").trim() ?? "";
    if (key && value) out[key] = value;
  }
  return out;
}

function parseUrlParams(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const value = safeDecode(String(raw ?? ""));
  const query = value.includes("?") ? value.split("?").slice(1).join("?") : value;
  for (const part of query.split(/[&#]/)) {
    const [k, ...rest] = part.split("=");
    if (!k || rest.length === 0) continue;
    const key = safeDecode(k).trim().toLowerCase();
    if (key.startsWith("utm_")) out[key] = safeDecode(rest.join("=")).trim();
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
    const res = await gamFetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
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
  networkCode: string; accessToken: string; ranges: GamRange[]; utmKeyIds: UtmKeyIds; debug: string[]; deadlineAt?: number; fastMode?: boolean;
}): Promise<AttributionResult> {
  const { networkCode, accessToken, ranges, debug, deadlineAt, fastMode } = args;
  const label = "KEY_VALUES_NAME";

  // Na API REST v1 do GAM, a dimensão aceitada para os key-values da requisição é KEY_VALUES_NAME
  // (formato "utm_campaign=123", "utm_source=google", etc.). CUSTOM_CRITERIA é o conceito/UI,
  // mas não é um enum válido do endpoint v1 e por isso zerava a atribuição.
  let reportRows: ReportRow[] = [];
  try {
    const metricGroups = [
      { label: "AD_EXCHANGE", metrics: ["AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE"] },
      ...(fastMode ? [] : [
        { label: "AD_SERVER", metrics: ["AD_SERVER_IMPRESSIONS", "AD_SERVER_REVENUE"] },
        { label: "ADSENSE", metrics: ["ADSENSE_IMPRESSIONS", "ADSENSE_REVENUE"] },
      ]),
    ];
    for (const group of metricGroups) {
      try {
        const groupRows = (await Promise.all(ranges.map((range) =>
          runReport({
            networkCode, accessToken, range,
            dimensions: ["DATE", "KEY_VALUES_NAME"],
            metrics: group.metrics,
            debug,
            deadlineAt,
          })
        ))).flat();
        debug.push(`[${networkCode}/${label}/${group.label}] rows=${groupRows.length}; revenue=${groupRows.reduce((sum, r) => sum + r.revenue, 0).toFixed(4)}`);
        reportRows.push(...groupRows);
      } catch (e) {
        debug.push(`[${networkCode}/${label}/${group.label}] erro=${String(e).slice(0, 500)}`);
      }
    }
  } catch (e) {
    debug.push(`[${networkCode}/${label}] erro=${String(e).slice(0, 500)}`);
    return { retentionRows: [], googleCampaignRows: [], googlePlacementRows: [], campaignSource: "none", placementSource: "none" };
  }

  const parsedRows = reportRows.map((r) => {
    const rawKv = r.dims[1] || ""; // KEY_VALUES_NAME é o 2º dim (após DATE)
    const kv = parseKeyValueDimension(rawKv);
    const sourceRaw = kv.utm_source ?? "";
    const campaignRaw = kv.utm_campaign ?? "";
    const placementRaw = kv.utm_placement ?? "";
    return { r, rawKv, sourceRaw, campaignRaw, placementRaw };
  });

  const rows: AttributedRow[] = parsedRows.map(({ r, rawKv, sourceRaw, campaignRaw, placementRaw }) => {
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
      raw: `utm_source=${sourceRaw || "null"}|utm_campaign=${campaignRaw || "null"}|utm_placement=${placementRaw || "null"}|raw=${rawKv.slice(0, 200)}`,
    };
  });

  // KEY_VALUES_NAME retorna uma linha por key-value; não podemos somar source+campaign+placement juntos,
  // senão a receita duplica. Para ROI usamos utm_campaign; para placements usamos utm_placement; para
  // Retenção/Push usamos só utm_source.
  const sourceRows: AttributedRow[] = parsedRows
    .filter(({ sourceRaw }) => isRealValue(sourceRaw))
    .map(({ r, rawKv, sourceRaw }) => ({
      date: r.date,
      impressions: r.impressions,
      revenue: r.revenue,
      source: safeDecode(sourceRaw).toLowerCase().trim() || "unknown",
      cid: null,
      placement: null,
      raw: `utm_source=${sourceRaw}|raw=${rawKv.slice(0, 200)}`,
    }));
  const campaignRows: AttributedRow[] = parsedRows
    .filter(({ campaignRaw }) => !!extractCampaignId(campaignRaw))
    .map(({ r, rawKv, campaignRaw }) => ({
      date: r.date,
      impressions: r.impressions,
      revenue: r.revenue,
      source: "google",
      cid: extractCampaignId(campaignRaw),
      placement: null,
      raw: `utm_source=google|utm_campaign=${campaignRaw}|raw=${rawKv.slice(0, 200)}`,
    }));
  const placementRows: AttributedRow[] = parsedRows
    .filter(({ placementRaw }) => !!extractCampaignId(placementRaw))
    .map(({ r, rawKv, placementRaw }) => {
      const cid = extractCampaignId(placementRaw);
      return {
        date: r.date,
        impressions: r.impressions,
        revenue: r.revenue,
        source: "google",
        cid,
        placement: isRealValue(placementRaw) ? extractPlacementValue(placementRaw, cid) : null,
        raw: `utm_source=google|utm_placement=${placementRaw}|raw=${rawKv.slice(0, 200)}`,
      };
    });

  // Debug agregado por source
  const sourceStats = rows.reduce((acc: Record<string, { rows: number; rev: number; cidOk: number }>, r) => {
    const s = acc[r.source] ?? { rows: 0, rev: 0, cidOk: 0 };
    s.rows++; s.rev += r.revenue; if (r.cid) s.cidOk++;
    acc[r.source] = s; return acc;
  }, {});
  debug.push(`[${networkCode}/${label}] total_rows=${rows.length}; por_source=${JSON.stringify(sourceStats)}`);

  // Debug linha-a-linha (até 20 amostras com receita > 0)
  const samples = [...campaignRows, ...placementRows, ...sourceRows].filter((r) => r.revenue > 0).slice(0, 20).map((r) =>
    `${r.date}|src=${r.source}|cid=${r.cid ?? "-"}|placement=${r.placement ?? "-"}|rev=${r.revenue.toFixed(4)}|${r.raw}`
  );
  debug.push(`[${networkCode}/${label}/sample] ${JSON.stringify(samples)}`);

  // Separa: utm_source=google → ROI/ROAS; demais → retenção
  const googleCampaignRows = campaignRows;
  const googlePlacementRows = placementRows.filter((r) => r.placement);
  const retentionRows = sourceRows; // Retenção/Push usa apenas linhas da key utm_source para não duplicar receita

  debug.push(`[${networkCode}/ATTRIBUTION] google_campaign_rows=${googleCampaignRows.length}; google_placement_rows=${googlePlacementRows.length}; retention_rows=${retentionRows.length}`);

  return {
    retentionRows,
    googleCampaignRows,
    googlePlacementRows,
    campaignSource: label,
    placementSource: label,
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

async function runUrlNameCandidate(
  networkCode: string,
  accessToken: string,
  ranges: GamRange[],
  debug: string[],
): Promise<{ label: string; rows: AttributedRow[] }> {
  const label = "URL_NAME (URL com parâmetros UTM)";
  try {
    const reportRows = (await Promise.all(ranges.map((range) =>
      runReport({ networkCode, accessToken, range, dimensions: ["DATE", "URL_NAME"], debug })
    ))).flat();
    const rows = rowsFromUrlReportRows(reportRows, label);
    debugUtmCandidate(networkCode, label, "utm_campaign+utm_placement", rows, debug);
    return { label, rows };
  } catch (e) {
    debug.push(`[${networkCode}/${label}] erro=${String(e).slice(0, 500)}`);
    return { label, rows: [] };
  }
}

async function persistGamUrlRevenue(args: {
  admin: any;
  userId: string;
  siteId: string | undefined;
  siteDomain?: string | null;
  networkCode: string;
  accessToken: string;
  ranges: GamRange[];
  debug: string[];
  ingestionDivisor: number;
  allowRelativeUrls?: boolean;
}) {
  const { admin, userId, siteId, siteDomain, networkCode, accessToken, ranges, debug, ingestionDivisor, allowRelativeUrls } = args;
  if (!siteId) return;
  const domain = normalizeDomain(siteDomain);
  const today = new Date().toISOString().slice(0, 10);
  const dates = expandFixedDates(ranges);
  if (dates.length > 0) {
    await admin.from("gam_url_revenue").delete().eq("user_id", userId).eq("site_id", siteId).in("date", dates);
  }

  for (const urlDimension of ["URL", "PAGE_PATH"]) {
    try {
      const filteredRows = (await Promise.all(expandToDailyGamRanges(ranges).map(async ({ range, date }) => {
        const rows = await runReport({
          networkCode,
          accessToken,
          range,
          dimensions: [urlDimension],
          metrics: ["AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE"],
          filters: buildPushKeyValueFilters(),
        expandedCompatibility: true,
          debug,
        });
        return rows.map((r) => ({ ...r, date }));
      }))).flat();
      console.log(`[${networkCode}] ${urlDimension} filtered by push key-values rows=${filteredRows.length}`);
      await persistUrlRevenueRows({ admin, userId, siteId, siteDomain: domain, networkCode, rows: filteredRows, source: "push", today, ingestionDivisor, allowRelativeUrls });
      return;
    } catch (e0) {
      console.log(`[${networkCode}] ${urlDimension} filtered by KEY_VALUES_NAME falhou (${String(e0).slice(0, 240)})`);
    }
  }
  console.log(`[${networkCode}] tentando fallback URL+KEY_VALUES_NAME`);

  let reportRows: ReportRow[] = [];
  const metricGroups = [
    { label: "AD_EXCHANGE", metrics: ["AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE"] },
    { label: "AD_SERVER", metrics: ["AD_SERVER_IMPRESSIONS", "AD_SERVER_REVENUE"] },
    { label: "ADSENSE", metrics: ["ADSENSE_IMPRESSIONS", "ADSENSE_REVENUE"] },
  ];
  try {
    for (const group of metricGroups) {
      const groupRows = (await Promise.all(ranges.map((range) =>
        runReport({ networkCode, accessToken, range, dimensions: ["DATE", "URL", "KEY_VALUES_NAME"], metrics: group.metrics, debug })
      ))).flat();
      reportRows.push(...groupRows);
      console.log(`[${networkCode}] URL+KEY_VALUES_NAME ${group.label} rows=${groupRows.length}`);
    }
  } catch (e1) {
    console.log(`[${networkCode}] URL+KEY_VALUES_NAME falhou (${String(e1).slice(0, 200)}), tentando URL_NAME+KEY_VALUES_NAME`);
    try {
      for (const group of metricGroups) {
        const groupRows = (await Promise.all(ranges.map((range) =>
          runReport({ networkCode, accessToken, range, dimensions: ["DATE", "URL_NAME", "KEY_VALUES_NAME"], metrics: group.metrics, debug })
        ))).flat();
        reportRows.push(...groupRows);
        console.log(`[${networkCode}] URL_NAME+KEY_VALUES_NAME ${group.label} rows=${groupRows.length}`);
      }
    } catch (e2) {
      console.error(`[${networkCode}] URL_NAME+KEY_VALUES_NAME tb falhou: ${String(e2).slice(0, 300)}`);
      console.error(`[${networkCode}] URL de push não foi persistida: GAM não aceitou URL + KEY_VALUES_NAME (${String(e2).slice(0, 300)})`);
      return;
    }
  }

  const buckets = new Map<string, {
    user_id: string; site_id: string; url: string; utm_source: string | null;
    date: string; revenue_usd: number; impressions: number;
  }>();
  const mediumFallback = new Map<string, {
    user_id: string; site_id: string; url: string; utm_source: string | null;
    date: string; revenue_usd: number; impressions: number;
  }>();
  for (const r of reportRows) {
    const rawUrl = String(r.dims[1] ?? "").trim();
    if (!isUrlForSite(rawUrl, domain, Boolean(allowRelativeUrls)) || !urlLooksLikePush(rawUrl)) continue;
    const kv = parseKeyValueDimension(r.dims[2] ?? "");
    const source = safeDecode(kv.utm_source ?? "").toLowerCase().trim();
    const medium = safeDecode(kv.utm_medium ?? "").toLowerCase().trim();
    const date = r.date ?? today;
    const revenue = (Number(r.revenue) || 0) / (ingestionDivisor || 1);
    const impressions = Number(r.impressions) || 0;

    if (isPushSourceValue(source)) {
      const key = `${date}|${rawUrl}`;
      const cur = buckets.get(key) ?? { user_id: userId, site_id: siteId, url: rawUrl, utm_source: source || "push", date, revenue_usd: 0, impressions: 0 };
      if (cur.utm_source && cur.utm_source !== source) cur.utm_source = `${cur.utm_source},${source}`;
      cur.revenue_usd += revenue;
      cur.impressions += impressions;
      buckets.set(key, cur);
      continue;
    }

    if (!source && isPushMediumValue(medium)) {
      const key = `${date}|${rawUrl}`;
      const cur = mediumFallback.get(key) ?? { user_id: userId, site_id: siteId, url: rawUrl, utm_source: `medium:${medium}`, date, revenue_usd: 0, impressions: 0 };
      cur.revenue_usd += revenue;
      cur.impressions += impressions;
      mediumFallback.set(key, cur);
    }
  }
  for (const [key, value] of mediumFallback) {
    if (!buckets.has(key)) buckets.set(key, value);
  }
  const payload = [...buckets.values()].map((row) => ({ ...row, utm_source: row.utm_source ?? "" }));
  console.log(`[${networkCode}] gam_url_revenue payload=${payload.length}; dates=${dates.join(",")}`);
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await admin
      .from("gam_url_revenue")
      .upsert(payload.slice(i, i + CHUNK), { onConflict: "user_id,site_id,url,date" });
    if (error) console.error(`[${networkCode}] gam_url_revenue upsert: ${error.message}`);
  }
}

function buildPushKeyValueFilters() {
  const values = [
    "utm_source=push",
    "utm_source=izooto",
    "utm_source=notification",
    "utm_source=notif",
    "utm_source=pushly",
    "utm_source=recupera",
    "utm_source=wpp",
    "utm_source=messenger",
    "utm_medium=notification",
    "utm_medium=push",
    "utm_medium=webpush",
  ].map((stringValue) => ({ stringValue }));

  return [{
    fieldFilter: {
      field: { dimension: "KEY_VALUES_NAME" },
      operation: "IN",
      values,
    },
  }];
}

async function persistUrlRevenueRows(args: {
  admin: any;
  userId: string;
  siteId: string;
  siteDomain?: string | null;
  networkCode: string;
  rows: ReportRow[];
  source: string;
  today: string;
  ingestionDivisor: number;
  allowRelativeUrls?: boolean;
}) {
  const { admin, userId, siteId, siteDomain, networkCode, rows, source, today, ingestionDivisor, allowRelativeUrls } = args;
  const buckets = new Map<string, { user_id: string; site_id: string; url: string; utm_source: string; date: string; revenue_usd: number; impressions: number }>();
  for (const r of rows) {
    const rawUrl = String(r.dims[1] ?? r.dims[0] ?? "").trim();
    if (!isUrlForSite(rawUrl, siteDomain, Boolean(allowRelativeUrls)) || !urlLooksLikePush(rawUrl)) continue;
    const date = r.date ?? today;
    const key = `${date}|${rawUrl}`;
    const cur = buckets.get(key) ?? { user_id: userId, site_id: siteId, url: rawUrl, utm_source: source, date, revenue_usd: 0, impressions: 0 };
    cur.revenue_usd += (Number(r.revenue) || 0) / (ingestionDivisor || 1);
    cur.impressions += Number(r.impressions) || 0;
    buckets.set(key, cur);
  }

  const payload = [...buckets.values()];
  console.log(`[${networkCode}] gam_url_revenue filtered payload=${payload.length}`);
  const dates = [...new Set(payload.map((row) => row.date))];
  if (dates.length > 0) {
    await admin.from("gam_url_revenue").delete().eq("user_id", userId).eq("site_id", siteId).in("date", dates);
  }
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await admin
      .from("gam_url_revenue")
      .upsert(payload.slice(i, i + CHUNK), { onConflict: "user_id,site_id,url,date" });
    if (error) console.error(`[${networkCode}] gam_url_revenue filtered upsert: ${error.message}`);
  }
}

const PUSH_SOURCE_VALUES = new Set(["push", "izooto", "notification", "notif", "pushly", "recupera", "wpp", "messenger"]);
const PUSH_MEDIUM_VALUES = new Set(["notification", "push", "webpush"]);

function isPushSourceValue(value: string) {
  const source = safeDecode(value).toLowerCase().trim();
  return PUSH_SOURCE_VALUES.has(source);
}

function isPushMediumValue(value: string) {
  const medium = safeDecode(value).toLowerCase().trim();
  return PUSH_MEDIUM_VALUES.has(medium);
}

function urlLooksLikePush(rawUrl: string) {
  const params = parseUrlParams(rawUrl);
  return isPushSourceValue(params.utm_source ?? "") || isPushMediumValue(params.utm_medium ?? "");
}

function normalizeDomain(value?: string | null) {
  return String(value ?? "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

function isUrlForSite(rawUrl: string, siteDomain?: string | null, allowRelativeUrls = false) {
  const url = String(rawUrl ?? "").trim();
  if (!url || url === "(not applicable)" || url === "(unknown)") return false;
  const domain = normalizeDomain(siteDomain);
  if (!domain) return true;
  if (url.startsWith("/")) return allowRelativeUrls;
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return allowRelativeUrls;
  }
}

function rowsFromUrlReportRows(reportRows: ReportRow[], label: string): AttributedRow[] {
  return reportRows.map((r) => {
    const rawUrl = r.dims[1] || r.dims[0] || "";
    const params = parseUrlParams(rawUrl);
    const sourceRaw = params.utm_source ?? "";
    const campaignRaw = params.utm_campaign ?? "";
    const placementRaw = params.utm_placement ?? "";
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
      raw: `${label}|utm_source_raw=${sourceRaw || "null"}|utm_campaign_raw=${campaignRaw || "null"}|utm_placement_raw=${placementRaw || "null"}|dim=URL_NAME|raw=${rawUrl}`,
    };
  }).filter((r) => r.source !== "unknown" || !!r.cid || !!r.placement);
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
  ingestionDivisor: number = 1,
) {
  if (!siteId) return;
  const today = new Date().toISOString().slice(0, 10);
  const buckets = new Map<string, { user_id: string; site_id: string; campaign_id: string; date: string; utm_source: string; revenue_usd: number; impressions: number }>();
  for (const r of rows) {
    const date = r.date ?? today;
    const source = (r.source || "unknown").toLowerCase();
    const cid = r.cid ?? "__aggregate__";
    const key = `${cid}|${date}|${source}`;
    const cur = buckets.get(key) ?? {
      user_id: userId, site_id: siteId, campaign_id: cid, date, utm_source: source, revenue_usd: 0, impressions: 0,
    };
    cur.revenue_usd += r.revenue / ingestionDivisor;
    cur.impressions += r.impressions;
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
  const byCampaign = arr.filter((b) => b.campaign_id !== "__aggregate__").length;
  debug.push(`[gam_campaign_source_revenue] ${arr.length} linha(s) (${byCampaign} por campanha, ${aggregated} agregadas sem cid); divisor=${ingestionDivisor}; receita por source=${JSON.stringify(sources)}`);
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
  ingestionDivisor: number = 1,
  siteCurrency: string = "USD",
) {
  if (!siteId) return;
  const today = new Date().toISOString().slice(0, 10);

  const placementBuckets = new Map<string, { user_id: string; site_id: string; campaign_id: string; placement: string; date: string; revenue_usd: number; impressions: number; source: string; utm_source: string; raw_utm: string }>();
  const directByDateCid = new Map<string, Map<string, { revenue: number; impressions: number }>>();
  const googleTotalByDate = new Map<string, { revenue: number; impressions: number }>();
  for (const r of googleCampaignRows) {
    const date = r.date ?? today;
    if (!r.cid) continue;
    // Normaliza para "USD-equivalente" (se site reporta BRL, divide por FX)
    const revNorm = r.revenue / ingestionDivisor;
    const tot = googleTotalByDate.get(date) ?? { revenue: 0, impressions: 0 };
    tot.revenue += revNorm; tot.impressions += r.impressions;
    googleTotalByDate.set(date, tot);
    if (!directByDateCid.has(date)) directByDateCid.set(date, new Map());
    const inner = directByDateCid.get(date)!;
    const cur = inner.get(r.cid) ?? { revenue: 0, impressions: 0 };
    cur.revenue += revNorm; cur.impressions += r.impressions;
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
    pb.revenue_usd += r.revenue / ingestionDivisor;
    pb.impressions += r.impressions;
    placementBuckets.set(key, pb);
  }

  // CRÍTICO: só deleta+reinsere se temos dados novos. Se o GAM falhou (429/quota/timeout)
  // e não retornou linhas, NÃO apaga — preserva o último bom snapshot na tabela.
  const arr = [...placementBuckets.values()];
  if (arr.length === 0) {
    debug.push(`[gam_placement_revenue] SKIP delete/insert: nenhum dado retornado pelo GAM (provável rate-limit/quota). Mantendo snapshot anterior.`);
  } else {
    const dates = [...new Set([...syncDates, ...arr.map((p) => p.date)])];
    await admin.from("gam_placement_revenue")
      .delete().eq("user_id", userId).eq("site_id", siteId).in("date", dates);
    const CHUNK = 500;
    for (let i = 0; i < arr.length; i += CHUNK) {
      await admin.from("gam_placement_revenue").insert(arr.slice(i, i + CHUNK));
    }
    debug.push(`[gam_placement_revenue] ${arr.length} linha(s) (site_currency=${siteCurrency}, divisor=${ingestionDivisor})`);
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

    // Agrega receita de TODAS as fontes (google, push, outras) para essas campanhas nesta data.
    // Fonte primária: gam_campaign_source_revenue — contém TODAS as utm_sources por campaign_id.
    // gam_placement_revenue só captura tráfego do Google Ads (utm_source=google), então
    // usá-la como primário subnotifica receita de pushes e outras fontes.
    const cids = [...new Set((metrics as any[]).map((m) => String(m.campaign_id)))];

    const { data: allSourceRows } = await admin
      .from("gam_campaign_source_revenue")
      .select("campaign_id, revenue_usd")
      .eq("user_id", userId)
      .eq("date", date)
      .in("campaign_id", cids);
    const aggregatedByCid = new Map<string, number>();
    for (const r of (allSourceRows ?? []) as any[]) {
      const cid = String(r.campaign_id);
      aggregatedByCid.set(cid, (aggregatedByCid.get(cid) ?? 0) + Number(r.revenue_usd ?? 0));
    }

    // Fallback: se uma campanha não aparecer em source_revenue, tenta placement_revenue.
    const missingCids = cids.filter((c) => !aggregatedByCid.has(c));
    if (missingCids.length > 0) {
      const { data: allPlacementRevenueRows } = await admin
        .from("gam_placement_revenue")
        .select("campaign_id, revenue_usd")
        .eq("user_id", userId)
        .eq("date", date)
        .in("campaign_id", missingCids);
      for (const r of (allPlacementRevenueRows ?? []) as any[]) {
        const cid = String(r.campaign_id);
        aggregatedByCid.set(cid, (aggregatedByCid.get(cid) ?? 0) + Number(r.revenue_usd ?? 0));
      }
    }
    const placementByCid = new Map<string, number>(); // mantido apenas para o log abaixo

    const directMap = directByDateCid.get(date) ?? new Map();
    const matchedIds = new Set<string>();
    const totalGoogle = googleTotalByDate.get(date) ?? { revenue: 0, impressions: 0 };
    let attributedRev = 0;
    for (const v of directMap.values()) attributedRev += (v as any).revenue;

    const updates: any[] = [];
    const matchDebug: string[] = [];
    for (const m of metrics as any[]) {
      const cid = String(m.campaign_id);
      const revenueUsd = aggregatedByCid.get(cid) ?? 0; // soma de todos os sites
      if (revenueUsd > 0) matchedIds.add(cid);
      const spendBrl = Number(m.spend ?? 0);
      const revenueBrl = revenueUsd * fx.usdBrl;
      const impressions = Number(m.impressions ?? 0);
      const profit = revenueBrl - spendBrl;
      const roi = spendBrl > 0 ? (profit / spendBrl) * 100 : 0;
      const roas = spendBrl > 0 ? revenueBrl / spendBrl : 0;
      const ecpm = impressions > 0 ? (revenueBrl / impressions) * 1000 : 0;
      updates.push({ id: m.id, revenue: revenueUsd, profit, roi, roas, ecpm });
      matchDebug.push(`cid=${cid}|rev_usd_agg=${revenueUsd.toFixed(4)}|spend_brl=${spendBrl.toFixed(2)}`);
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
    debug.push(`[daily_metrics] ${date}: ${matchedIds.size}/${metrics.length} campanhas com receita agregada (placements=${placementByCid.size}, fallback_utm_campaign=${aggregatedByCid.size - placementByCid.size})`);
    debug.push(`[daily_metrics/${date}/match] ${JSON.stringify(matchDebug.slice(0, 30))}`);
  }
}

interface RunReportArgs {
  networkCode: string;
  accessToken: string;
  range: GamRange;
  dimensions: string[];
  metrics?: string[];
  filters?: any[];
  expandedCompatibility?: boolean;
  dimensionKeyIds?: string[];
  dimensionKeyIdsField?: "customDimensionKeyIds" | "ekvDimensionKeyIds";
  debug: string[];
  deadlineAt?: number;
}

async function runReport(args: RunReportArgs): Promise<ReportRow[]> {
  const { networkCode, accessToken, range, dimensions, metrics, filters, expandedCompatibility, dimensionKeyIds, dimensionKeyIdsField, debug, deadlineAt } = args;
  const tag = `${networkCode}/${dimensions.join("+")}`;
  const ensureBudget = (minimumMs = 8_000) => {
    if (deadlineAt && Date.now() + minimumMs >= deadlineAt) {
      throw new Error(`[${tag}] aborted before Edge timeout`);
    }
  };
  ensureBudget(20_000);

  const reportDefinition: any = {
    reportType: "HISTORICAL",
    dimensions,
    metrics: metrics ?? [
      "AD_SERVER_IMPRESSIONS",
      "AD_SERVER_REVENUE",
      "AD_EXCHANGE_IMPRESSIONS",
      "AD_EXCHANGE_REVENUE",
      "ADSENSE_IMPRESSIONS",
      "ADSENSE_REVENUE",
    ],
    dateRange: range.dateRange,
  };
  if (filters?.length) reportDefinition.filters = filters;
  if (expandedCompatibility) reportDefinition.expandedCompatibility = true;
  if (dimensionKeyIds?.length) reportDefinition[dimensionKeyIdsField ?? "customDimensionKeyIds"] = dimensionKeyIds;

  const reportBody = { visibility: "DRAFT", reportDefinition };
  const createRes = await gamFetch(`${GAM_BASE}/networks/${networkCode}/reports`, {
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

  const runRes = await gamFetch(`${GAM_BASE}/${reportName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const runJson = await parseJsonResponse(runRes, "run report", tag);
  if (!runRes.ok) throw new Error(`[${tag}] run failed: ${JSON.stringify(runJson)}`);
  const opName: string = runJson.name;

  let resultName: string | null = null;
  for (let i = 0; i < 30; i++) {
    ensureBudget(10_000);
    await new Promise((r) => setTimeout(r, 2000));
    const opRes = await gamFetch(`${GAM_BASE}/${opName}`, { headers: { Authorization: `Bearer ${accessToken}` } });
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
    ensureBudget(10_000);
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    const rowsRes = await gamFetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
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
      // GAM revenue: SEMPRE em micros quando vem como intValue (1 USD = 1_000_000).
      // doubleValue (raro) já vem na moeda nativa.
      const numRevenue = (v: any) => {
        if (v == null) return 0;
        if (v.intValue != null) return Number(v.intValue) / 1_000_000;
        if (v.doubleValue != null) return Number(v.doubleValue);
        return 0;
      };
      const isActiveView = !!metrics && metrics.length === 4
        && metrics[1].includes("MEASURABLE") && metrics[2].includes("VIEWABLE");
      let impressions: number;
      let revenue: number;
      let _raw_measurable: number | undefined;
      let _raw_viewable: number | undefined;
      if (isActiveView) {
        impressions = num(m[0]);
        _raw_measurable = num(m[1]);
        _raw_viewable = num(m[2]);
        revenue = numRevenue(m[3]);
      } else if (metrics) {
        impressions = num(m[0]);
        revenue = numRevenue(m[1]);
      } else {
        impressions = num(m[0]) + num(m[2]) + num(m[4]);
        revenue = numRevenue(m[1]) + numRevenue(m[3]) + numRevenue(m[5]);
      }
      allRows.push({ date, dims: dimStrings, impressions, revenue, _raw_measurable, _raw_viewable });
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

// Lê o currencyCode da Network GAM (para auto-detecção de moeda por site)
async function fetchNetworkCurrency(networkCode: string, accessToken: string, debug: string[]): Promise<string | null> {
  try {
    const res = await gamFetch(`${GAM_BASE}/networks/${networkCode}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    if (!res.ok) {
      debug.push(`[network ${networkCode}] currency lookup failed (${res.status}): ${text.slice(0, 150)}`);
      return null;
    }
    const j = JSON.parse(text);
    const cc = String(j?.currencyCode ?? "").toUpperCase();
    if (cc) {
      debug.push(`[network ${networkCode}] detected currency=${cc}`);
      return cc;
    }
  } catch (e) {
    debug.push(`[network ${networkCode}] currency lookup erro: ${String(e)}`);
  }
  return null;
}

async function persistSiteMetricsDaily(
  admin: any,
  userId: string,
  siteId: string | null | undefined,
  currency: string,
  rows: Array<{ date: string | null; impressions: number; measurable: number; viewable: number; revenue: number }>,
  debug: string[],
) {
  if (!siteId || rows.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  // Agrega por data (caso múltiplos ranges retornem mesmo dia)
  const byDate = new Map<string, { impr: number; meas: number; view: number; rev: number }>();
  for (const r of rows) {
    const d = r.date ?? today;
    const cur = byDate.get(d) ?? { impr: 0, meas: 0, view: 0, rev: 0 };
    cur.impr += r.impressions; cur.meas += r.measurable; cur.view += r.viewable; cur.rev += r.revenue;
    byDate.set(d, cur);
  }
  const payload = [...byDate.entries()].map(([date, v]) => ({
    user_id: userId,
    site_id: siteId,
    date,
    impressions: v.impr,
    measurable_impressions: v.meas,
    viewable_impressions: v.view,
    revenue_native: v.rev,
    currency,
    ecpm_native: v.impr > 0 ? (v.rev / v.impr) * 1000 : 0,
    updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < payload.length; i += 500) {
    await admin.from("site_metrics_daily").upsert(payload.slice(i, i + 500), { onConflict: "user_id,site_id,date" });
  }
  debug.push(`[site_metrics_daily] site=${siteId} rows=${payload.length} currency=${currency}`);
}
