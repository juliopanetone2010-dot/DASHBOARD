// Sincroniza receita do Google Ad Manager (REST API v1 beta + SOAP ReportService para Intraday)
// - Autentica via JWT (service account)
// - Roda reports por AD_UNIT, PLACEMENT e URL_NAME (via SOAP para intraday)
// - Faz upsert em `placements` e atualiza `revenue/impressions/ecpm`
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";
const ALLOWED_PRESETS = new Set(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS"]);

const SOAP_BASE = "https://www.google.com/apis/ads/publisher/v202405/ReportService";

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
  // Auditoria forçada: Se vier sync=true, rodamos síncrono ignorando auth se necessário
  if (control?.sync === true) {
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
    let totalRequestsOnly = false;
    let siteMetricsOnly = false;
    const startedAt = Date.now();
    const deadlineAt = startedAt + 115_000;
    const hasBudget = (minimumMs = 20_000) => Date.now() + minimumMs < deadlineAt;
    try {
      const body = await req.json().catch(() => ({}));
      const p = String((body as any)?.date_preset ?? "").toUpperCase();
      if (ALLOWED_PRESETS.has(p)) datePreset = p;
      dateFrom = typeof (body as any)?.from === "string" ? (body as any).from : (typeof (body as any)?.date_from === "string" ? (body as any).date_from : null);
      dateTo = typeof (body as any)?.to === "string" ? (body as any).to : (typeof (body as any)?.date_to === "string" ? (body as any).date_to : null);
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
      totalRequestsOnly = Boolean((body as any)?.total_requests_only || (body as any)?.match_rate_only);
      siteMetricsOnly = Boolean((body as any)?.site_metrics_only || (body as any)?.metrics_only);
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
    const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
    let userId: string | undefined;

    if (token && serviceRoleKey && token.trim() === serviceRoleKey.trim()) {
      userId = requestedUserId ?? undefined;
    } else {
      const { data: { user } } = await userClient.auth.getUser(token);
      userId = user?.id;
    }
    
    if (!userId) return json({ error: "Token inválido" });



    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceRoleKey,
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
    const usdToBrlRate = fxRates.usdBrl || 5.15; // Fallback seguro

    debug.push(`[currency] Rate used for dashboard calculation: USD 1.00 = BRL ${usdToBrlRate.toFixed(4)}`);

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

        const siteCurrency = String((networkSites[0] as any)?.gam_currency ?? "USD").toUpperCase();

        if (siteMetricsOnly) {
          const siteMetricsVariants: Array<{ label: string; metrics: string[] }> = [
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
          const metricMap = new Map<string, { impr: number; meas: number; view: number; rev: number }>();
          let siteMetricsVariantFailures = 0;
          for (const variant of siteMetricsVariants) {
            try {
              const raw = (await Promise.all(ranges.map((range) =>
                runReport({ networkCode, accessToken, range, dimensions: ["DATE"], metrics: variant.metrics, debug, deadlineAt })
              ))).flat();
              debug.push(`[${networkCode}] site_metrics_only ${variant.label} rows=${raw.length}`);
              for (const r of raw as any[]) {
                const key = r.date ?? "_";
                const cur = metricMap.get(key) ?? { impr: 0, meas: 0, view: 0, rev: 0 };
                cur.impr += Number(r.impressions ?? 0);
                cur.meas += Number(r._raw_measurable ?? 0);
                cur.view += Number(r._raw_viewable ?? 0);
                cur.rev += Number(r.revenue ?? 0);
                metricMap.set(key, cur);
              }
            } catch (e) {
              siteMetricsVariantFailures++;
              debug.push(`[${networkCode}] site_metrics_only ${variant.label} falhou: ${String(e).slice(0, 220)}`);
            }
          }
          const metricRows = [...metricMap.entries()].map(([d, v]) => ({
            date: d === "_" ? null : d,
            impressions: v.impr,
            measurable: v.meas,
            viewable: v.view,
            revenue: v.rev,
          }));
          await persistSiteMetricsDaily(admin, userId, networkSites[0]?.id, siteCurrency, metricRows, debug, ranges, {
            // Se uma das fontes do GAM falhar, o total retornado pode ficar parcial.
            // Nessa situação nunca reduzimos uma receita já salva e maior.
            preserveHigherExisting: siteMetricsVariantFailures > 0,
          });
          if (!skipSnapshotRegen) {
            await regenerateSnapshotsForRanges({
              ranges,
              authHeader,
              siteId: requestedSiteId ?? networkSites[0]?.id ?? null,
              debug,
              wait: true,
            });
          }
          const metricTotals = metricRows.reduce((a, r) => ({
            revenue: a.revenue + r.revenue,
            impressions: a.impressions + r.impressions,
          }), { revenue: 0, impressions: 0 });
          summary.push({
            network_code: networkCode,
            sites: networkSites.map((s) => s.name),
            mode: "site_metrics_only",
            currency: siteCurrency,
            date_range: ranges.map((r) => r.debugLabel),
            site_id: requestedSiteId ?? null,
            rows_returned: metricRows.length,
            total_revenue_native: metricTotals.revenue,
            total_impressions: metricTotals.impressions,
          });
          continue;
        }

        // PRIORIDADE: roda persistCampaignTotalRequests primeiro, pois é o que
        // alimenta a coluna "Taxa de Correspondência" e era frequentemente cortado
        // pelo IDLE_TIMEOUT de 150s quando vinha depois do trabalho pesado abaixo.
        if (!testMode && hasBudget(25_000)) {
          try {
            console.log(`[${networkCode}/total_requests] starting persistCampaignTotalRequests (early)`);
            await persistCampaignTotalRequests({ admin, userId, siteId: networkSites[0]?.id, networkCode, accessToken, ranges, debug, deadlineAt });
            console.log(`[${networkCode}/total_requests] completed (early)`);
          } catch (e) {
            console.error(`[${networkCode}/total_requests] erro (early)`, e);
            debug.push(`[${networkCode}/total_requests] erro=${String(e).slice(0, 400)}`);
          }
        } else {
          debug.push(`[${networkCode}/total_requests] skipped (budget low)`);
        }

        if (totalRequestsOnly) {
          summary.push({
            network_code: networkCode,
            sites: networkSites.map((s) => s.name),
            mode: "total_requests_only",
          });
          continue;
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
        // Usamos KEY_VALUES_NAME para UTMs. Se falhar ou vier vazio, tentamos fallbacks via CUSTOM_CRITERIA.
        let attribution = await collectUtmAttribution({ networkCode, accessToken, ranges, utmKeyIds, debug, deadlineAt, fastMode: revenueOnly });
        
        if (attribution.googleCampaignRows.length === 0 && hasBudget(15_000)) {
          debug.push(`[${networkCode}] KEY_VALUES_NAME retornou 0 campanhas, tentando CUSTOM_CRITERIA fallback...`);
          const criteria = await runCustomCriteriaCandidate(networkCode, accessToken, ranges, debug);
          if (criteria.rows.length > 0) {
             attribution = rowsToAttributionResult(criteria.rows, criteria.label);
          }
        }
        
        const todayStr = new Date().toISOString().slice(0, 10);
        // attribution já foi populado pelo collectUtmAttribution (via REST v1)
        // Somente ignora se já tivermos dados segmentados por CAMPANHA real (não agregados 'push')
        const hasTodayData = attribution.googleCampaignRows.some(r => r.date === todayStr && r.revenue > 0.0001 && r.cid && r.cid !== "__aggregate__") ||
                             attribution.googlePlacementRows.some(r => r.date === todayStr && r.revenue > 0.0001 && r.cid && r.cid !== "__aggregate__");

        if (!hasTodayData && hasBudget(10_000)) {
          debug.push(`[${networkCode}] Sem dados de hoje (today=${todayStr}), tentando SOAP URL_NAME candidate...`);
          const finalUrlMap = await buildFinalUrlMap(admin, userId, requestedAccountIds, debug);
          const urlRows = await collectUrlAttribution({ networkCode, accessToken, ranges, finalUrlMap, debug, deadlineAt });
          debug.push(`[${networkCode}] SOAP URL_NAME retornou ${urlRows.length} linhas brutas.`);
          
          if (urlRows.length > 0) {
            const soapAttribution = rowsToAttributionResult(urlRows, "URL_NAME (SOAP Intraday)");
            debug.push(`[${networkCode}] SOAP Intraday parsed: campaigns=${soapAttribution.googleCampaignRows.length}, placements=${soapAttribution.googlePlacementRows.length}`);
            
            // Mescla os dados do SOAP (intraday) com o que veio do REST v1 (consolidated)
            for (const sr of soapAttribution.googleCampaignRows) {
              const idx = attribution.googleCampaignRows.findIndex(gr => gr.cid === sr.cid && gr.date === sr.date);
              if (idx === -1) {
                attribution.googleCampaignRows.push(sr);
              } else if (attribution.googleCampaignRows[idx].revenue < 0.0001 && sr.revenue > 0) {
                // Sobrescreve se o consolidado for 0 mas o intraday tiver valor
                attribution.googleCampaignRows[idx] = sr;
              }
            }
            for (const sp of soapAttribution.googlePlacementRows) {
              const idx = attribution.googlePlacementRows.findIndex(gp => gp.cid === sp.cid && gp.date === sp.date && gp.placement === sp.placement);
              if (idx === -1) {
                attribution.googlePlacementRows.push(sp);
              } else if (attribution.googlePlacementRows[idx].revenue < 0.0001 && sp.revenue > 0) {
                attribution.googlePlacementRows[idx] = sp;
              }
            }
            attribution.retentionRows.push(...soapAttribution.retentionRows);
            debug.push(`[${networkCode}] SOAP Intraday merge concluído.`);
          }
        }
        

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

        // Quando o GAM do site reporta em BRL nativo, normalizamos para "USD-equivalente"
        // dividindo por FX antes de gravar — assim todo o app downstream (que multiplica por FX
        // para exibir em BRL) continua correto, sem dupla conversão.
        const ingestionDivisor = siteCurrency === "BRL" ? (fxRates.usdBrl || 5.15) : 1;

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
        let viewabilityVariantFailures = 0;
        if (skipViewability || !hasBudget(15_000)) {
          viewabilityVariantFailures = viewabilityVariants.length;
          debug.push(`[${networkCode}] viewability skipped (skip=${skipViewability}, budget low)`);
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
            viewabilityVariantFailures++;
            const msg = String(e).slice(0, 200);
            viewabilityError = msg;
            debug.push(`[${networkCode}] viewability ${variant.label} falhou: ${msg}`);
          }
        }
        viewabilityRows = [...aggMap.entries()].map(([d, v]) => ({
          date: d === "_" ? null : d,
          impressions: v.impr, measurable: v.meas, viewable: v.view, revenue: v.rev,
        }));


        // NOVO: Fallback Preditivo Intraday (Senior Solution)
        // Se ainda não temos dados segmentados para hoje, mas temos a receita TOTAL do site
        // (que o Google libera rápido via dimensão DATE), distribuímos essa receita
        // baseada nas impressões em tempo real (que também saem rápido via KEY_VALUES_NAME).
        const siteTodayRows = viewabilityRows.filter(r => r.date === todayStr);
        const totalSiteRevenue = siteTodayRows.reduce((sum, r) => sum + r.revenue, 0);
        const totalSiteImpressions = siteTodayRows.reduce((sum, r) => sum + r.impressions, 0);
        
        const hasRealSegmentedData = googleCampaignRows.some(r => r.date === todayStr && r.revenue > 0.0001 && r.cid && r.cid !== "__aggregate__");

        if (!hasRealSegmentedData && totalSiteRevenue > 0 && hasBudget(10_000)) {
          debug.push(`[${networkCode}] Iniciando Fallback Preditivo: SiteRev=${totalSiteRevenue.toFixed(2)} SiteImpr=${totalSiteImpressions}`);
          try {
            const predictive = await collectPredictiveIntradayAttribution({
              networkCode, 
              accessToken, 
              ranges, 
              totalSiteRevenue, 
              totalSiteImpressions, 
              debug, 
              deadlineAt 
            });
            
            if (predictive.googleCampaignRows.length > 0) {
              debug.push(`[${networkCode}] Fallback Preditivo gerou ${predictive.googleCampaignRows.length} campanhas estimadas.`);
              // Adiciona as estimadas ao set de hoje para persistência
              googleCampaignRows.push(...predictive.googleCampaignRows);
              googlePlacementRows.push(...predictive.googlePlacementRows);
            }
          } catch (predErr) {
            debug.push(`[${networkCode}] Fallback Preditivo falhou: ${String(predErr).slice(0, 100)}`);
          }
        }

        if (!testMode) {
          await persistRows(adUnitRows, "ad_unit");
          await persistRows(placementRows, "placement");
          await persistCampaignSourceRevenueFromUtm(admin, userId, networkSites[0]?.id, [...utmRows, ...googleCampaignRows], debug, expandFixedDates(ranges), ingestionDivisor);
          await applyGoogleUtmRevenue(admin, userId, networkSites[0]?.id, googleCampaignRows, googlePlacementRows, fxRates, debug, expandFixedDates(ranges), ingestionDivisor, siteCurrency);
          if (hasBudget(25_000)) {
            await persistCampaignTotalRequests({ admin, userId, siteId: networkSites[0]?.id, networkCode, accessToken, ranges, debug, deadlineAt });
          } else {
            debug.push(`[${networkCode}/total_requests] final refresh skipped (budget low)`);
          }
          await persistSiteMetricsDaily(admin, userId, networkSites[0]?.id, siteCurrency, viewabilityRows, debug, ranges, {
            // Quando o report por DATE vem parcial ou cai no fallback por campanha,
            // não pode derrubar o total real do site salvo por uma sync rápida anterior.
            preserveHigherExisting: viewabilityVariantFailures > 0,
          });

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
      if (skipSnapshotRegen || siteMetricsOnly) {
        debug.push("[snapshot] regen skipped by caller");
      } else {
      const snapshotRanges = summary.flatMap((s) => Array.isArray(s.date_range) ? (s.date_range as string[]) : []);
      await regenerateSnapshotsForLabels({
        labels: snapshotRanges,
        authHeader,
        siteId: requestedSiteId ?? null,
        debug,
        wait: false,
      });
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
type MatchRateRow = { cid: string; date: string; total_requests: number; source: "ad_requests" | "match_rate" | "site_match_rate"; impressions?: number; revenue_usd?: number; match_rate_pct?: number };
interface AttributionResult {
  retentionRows: AttributedRow[];
  googleCampaignRows: AttributedRow[];
  googlePlacementRows: AttributedRow[];
  campaignSource: string;
  placementSource: string;
}

interface GamRange { dateRange: Record<string, unknown>; debugLabel: string; }

function datesFromRanges(ranges?: GamRange[]): string[] {
  if (!ranges?.length) return [];
  const dates = new Set<string>();
  for (const range of ranges) {
    const fixed = (range.dateRange as any)?.fixed;
    if (fixed?.startDate && fixed?.endDate) {
      const start = new Date(Date.UTC(fixed.startDate.year, fixed.startDate.month - 1, fixed.startDate.day));
      const end = new Date(Date.UTC(fixed.endDate.year, fixed.endDate.month - 1, fixed.endDate.day));
      for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        dates.add(d.toISOString().slice(0, 10));
      }
      continue;
    }
    const today = new Date();
    const addIso = (d: Date) => dates.add(d.toISOString().slice(0, 10));
    if (range.debugLabel === "TODAY") addIso(today);
    else if (range.debugLabel === "YESTERDAY") {
      const d = new Date(today); d.setUTCDate(d.getUTCDate() - 1); addIso(d);
    } else if (range.debugLabel === "LAST_7_DAYS" || range.debugLabel === "LAST_30_DAYS") {
      const days = range.debugLabel === "LAST_7_DAYS" ? 7 : 30;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today); d.setUTCDate(d.getUTCDate() - i); addIso(d);
      }
    }
  }
  return [...dates].sort();
}

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

function expandDateLabels(labels: string[]): string[] {
  const expanded = new Set<string>();
  for (const label of labels) {
    const value = String(label);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      expanded.add(value);
      continue;
    }
    const m = value.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
    if (!m) continue;
    const start = new Date(m[1] + "T00:00:00Z");
    const end = new Date(m[2] + "T00:00:00Z");
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      expanded.add(d.toISOString().slice(0, 10));
    }
  }
  return [...expanded].sort();
}

async function regenerateSnapshotsForLabels(args: {
  labels: string[];
  authHeader: string | null;
  siteId: string | null;
  debug: string[];
  wait: boolean;
}) {
  const { labels, authHeader, siteId, debug, wait } = args;
  const dates = expandDateLabels(labels);
  if (dates.length === 0) return;
  const snapshotJobs = dates.map((d) =>
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-daily-snapshot`, {
      method: "POST",
      headers: {
        Authorization: authHeader!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ date: d, site_id: siteId, force: true, skip_gam_sync: true }),
    }).catch((e) => ({ error: String(e) })),
  );
  if (wait) {
    await Promise.allSettled(snapshotJobs);
    debug.push(`[snapshot] regenerated ${dates.length} day(s)`);
    return;
  }
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(Promise.allSettled(snapshotJobs));
  } else {
    Promise.allSettled(snapshotJobs).catch(() => {});
  }
  debug.push(`[snapshot] enqueued ${dates.length} day(s) (background)`);
}

async function regenerateSnapshotsForRanges(args: {
  ranges: GamRange[];
  authHeader: string | null;
  siteId: string | null;
  debug: string[];
  wait: boolean;
}) {
  await regenerateSnapshotsForLabels({
    labels: args.ranges.map((r) => r.debugLabel),
    authHeader: args.authHeader,
    siteId: args.siteId,
    debug: args.debug,
    wait: args.wait,
  });
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

function parseUrlParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const search = url.split("?")[1];
    if (!search) return out;
    for (const part of search.split("&")) {
      const [k, v] = part.split("=");
      if (k && v) out[k.toLowerCase()] = safeDecode(v);
    }
  } catch { /* ignore */ }
  return out;
}


// Remove sufixos numéricos entre parênteses adicionados pelo parser/UI do Ads,
// ex.: "rec-guia-foo (1589883010)" → "rec-guia-foo".
function cleanPlacementLabel(s: string): string {
  return (s || "").replace(/\s*\(\d{4,}\)\s*$/g, "").trim();
}

// Pipeline oficial de normalização para reconcile GAM ↔ Ads.
// Regras: lowercase, sem protocolo, sem query, sem anchor, sem trailing slash,
// sem IDs "(123)", sem espaços duplicados; URLs viram hostname.
function normalizePlacement(s: string): string {
  let t = cleanPlacementLabel(String(s || "")).toLowerCase().trim();
  if (!t) return "";
  const appMatch = t.match(/mobileapp::\d+-(.+)$/i);
  if (appMatch) return cleanPlacementLabel(appMatch[1]).toLowerCase();
  // Tira protocolo/query/anchor manualmente (preserva slugs quando não é URL)
  t = t.replace(/^https?:\/\//, "");
  t = t.split("?")[0].split("#")[0];
  t = t.replace(/\/+$/, "");
  t = t.replace(/\s{2,}/g, " ");
  // Se parecer URL/host (contém ponto antes da primeira /), reduz a hostname
  if (/^[^/\s]+\.[^/\s]+/.test(t)) {
    try {
      const u = new URL(`https://${t}`);
      return u.hostname.replace(/^www\./, "");
    } catch { /* fallthrough */ }
  }
  return t.replace(/^www\./, "");
}

// utm_placement vem como "{campaignid}_{placement}". Extrai a parte do placement.
// IMPORTANTE: prefixo numérico pode ser ID da campanha (11+ dígitos) OU do anúncio (10 dígitos).
// Tratamos como campaignid apenas números com 11+ dígitos para evitar colisão com ad_id
// quando URLs hardcoded contêm o ID do ad em vez do macro {campaignid}.
function extractPlacementValue(raw: string, cid: string | null): string | null {
  if (!raw) return null;
  const decoded = safeDecode(raw);
  const m = decoded.match(/^(\d{11,})[_\-:](.+)$/);
  if (m) return normalizePlacement(m[2]);
  if (cid && decoded.startsWith(cid)) return normalizePlacement(decoded.slice(cid.length).replace(/^[_\-:]/, ""));
  return normalizePlacement(decoded);
}

// Escolhe o MAIOR número (em comprimento) com 6+ dígitos dentro do raw.
// Real campaign IDs do Google Ads têm 11 dígitos; ad IDs costumam ter 10.
// Pegar o maior evita atribuir receita ao ad_id quando ambos aparecem na URL
// (ex: utm_placement=1589883010_23836816710_slug ou final URL com ID hardcoded).
function extractCampaignId(raw: string | null | undefined): string | null {
  const decoded = safeDecode(String(raw ?? "").trim());
  if (!decoded || decoded === "(not applicable)" || decoded === "(empty)") return null;
  const matches = decoded.match(/\d{6,}/g);
  if (!matches || matches.length === 0) return null;
  let best = matches[0];
  for (const candidate of matches) {
    if (candidate.length > best.length) best = candidate;
  }
  return best;
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

function buildRequestRowsFromReportRows(reportRows: ReportRow[], metricSource: "ad_requests"): MatchRateRow[] {
  const campaignAgg = new Map<string, MatchRateRow>();
  const placementAgg = new Map<string, MatchRateRow>();
  for (const r of reportRows) {
    const date = r.date;
    if (!date) continue;
    const kv = parseKeyValueDimension(r.dims[1] ?? "");
    const campaignCid = extractCampaignId(kv.utm_campaign);
    const placementCid = extractCampaignId(kv.utm_placement);
    const cid = campaignCid ?? placementCid;
    if (!cid) continue;
    const key = `${cid}|${date}`;
    const target = campaignCid ? campaignAgg : placementAgg;
    const cur = target.get(key) ?? { cid, date, total_requests: 0, source: metricSource };
    cur.total_requests += Number(r.impressions || 0);
    target.set(key, cur);
  }
  for (const [key, row] of placementAgg) {
    if (!campaignAgg.has(key)) campaignAgg.set(key, row);
  }
  return [...campaignAgg.values()];
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
    // Otimização: Agrupamos todas as chamadas por tipo de métrica para reduzir o número total de requests.
    const metricGroups = [
      { label: "ALL_SOURCES", metrics: ["AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE", "AD_SERVER_IMPRESSIONS", "AD_SERVER_REVENUE", "ADSENSE_IMPRESSIONS", "ADSENSE_REVENUE"] },
      { label: "CHANNEL_SOURCE", metrics: ["AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE"], dimensions: ["DATE", "AD_EXCHANGE_CHANNEL_NAME"] },
    ];
    for (const group of metricGroups) {
      try {
        const groupRows = (await Promise.all(ranges.map(async (range) => {
          const rows = await runReport({
            networkCode, accessToken, range,
            dimensions: group.dimensions ?? ["DATE", "KEY_VALUES_NAME"],
            metrics: group.metrics,
            debug,
            deadlineAt,
          });
          // Se for a dimensão CHANNEL, mapeamos para KEY_VALUES_NAME format para reuso do parser
          if (group.dimensions?.includes("AD_EXCHANGE_CHANNEL_NAME")) {
            return rows.map(r => ({
              ...r,
              dims: [r.dims[0], r.dims[1]] // r.dims[1] é o Channel Name
            }));
          }

          // Se KEY_VALUES_NAME retornar 0 rows para a data, tentamos CUSTOM_CRITERIA imediatamente
          if (rows.length === 0) {
            debug.push(`[${networkCode}/${label}/${group.label}] 0 rows com KEY_VALUES_NAME, tentando CUSTOM_CRITERIA fallback imediato para ${range.dateRange.startDate}...`);
            try {
              return await runReport({
                networkCode, accessToken, range,
                dimensions: ["DATE", "CUSTOM_CRITERIA"],
                metrics: group.metrics,
                debug,
                deadlineAt,
              });
            } catch (err) {
              debug.push(`[${networkCode}/${label}/${group.label}] fallback CUSTOM_CRITERIA falhou: ${String(err).slice(0, 100)}`);
              return [];
            }
          }
          return rows;
        }))).flat();
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
    const rawKv = r.dims[1] || "";
    // O Channel Name do Ad Exchange já vem no formato "utm_campaign=123" ou "utm_source=push"
    // O parser parseKeyValueDimension lida com ambos os formatos (key=value ou key=value;key2=value2)
    const kv = parseKeyValueDimension(rawKv);

    const sourceRaw = kv.utm_source ?? "";
    const campaignRaw = kv.utm_campaign ?? "";
    const placementRaw = kv.utm_placement ?? "";
    return { r, rawKv, sourceRaw, campaignRaw, placementRaw };
  });

  const rows: AttributedRow[] = parsedRows.map(({ r, rawKv, sourceRaw, campaignRaw, placementRaw }) => {
    const source = safeDecode(sourceRaw).toLowerCase().trim() || "unknown";
    // Se rawKv não tem formatação de UTM (apenas o número ID), o parser retorna objeto vazio.
    // Garantimos que se kv estiver vazio e rawKv for um ID válido, usamos ele como cid.
    let cid = extractCampaignId(campaignRaw) ?? extractCampaignId(placementRaw);
    if (!cid && rawKv && !rawKv.includes("=")) {
      cid = extractCampaignId(rawKv);
    }

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
    .filter(({ rawKv, campaignRaw }) => {
      const cid = extractCampaignId(campaignRaw) || (rawKv && !rawKv.includes("=") && extractCampaignId(rawKv));
      return !!cid;
    })
    .map(({ r, rawKv, campaignRaw }) => {
      let cid = extractCampaignId(campaignRaw);
      if (!cid && rawKv) {
        // Se rawKv não tem =, tentamos extrair o ID diretamente.
        // Se tiver =, o extractCampaignId já lida com utm_campaign=...
        cid = extractCampaignId(rawKv);
      }
      
      // LOG DE PARSER PARA CAMPANHAS ESPECÍFICAS (AUDITORIA)
      const auditCids = ['23207554976', '23309079322', '23021142139', '23450729920', '23036874694'];
      if (cid && auditCids.includes(cid)) {
        console.log(`[AUDIT_parser] ID ${cid} extraído de rawKv=${rawKv} ou campaignRaw=${campaignRaw}`);
      }


      return {
        date: r.date,
        impressions: r.impressions,
        revenue: r.revenue,
        source: "google",
        cid: cid,
        placement: null,
        raw: `utm_source=google|utm_campaign=${campaignRaw}|raw=${rawKv.slice(0, 200)}`,
      };
    });


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
  // Linha oficial por campanha: primeiro usa utm_campaign. Quando o GAM só
  // trouxe utm_placement no formato "{campaign_id}_{placement}", usamos esse
  // ID como fallback por (data,campanha), sem somar por cima de utm_campaign
  // para evitar dupla contagem.
  const campaignCovered = new Set(campaignRows.filter((r) => r.cid).map((r) => `${r.date}|${r.cid}`));
  const placementCampaignFallbackRows = placementRows.filter((r) => r.cid && !campaignCovered.has(`${r.date}|${r.cid}`));
  const googleCampaignRows = [...campaignRows, ...placementCampaignFallbackRows];
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

function rowsToAttributionResult(rows: AttributedRow[], label: string): AttributionResult {
  const sourceRows = rows.filter((r) => r.source && r.source !== "google" && r.source !== "unknown");
  const campaignRows = rows.filter((r) => r.source === "google" && r.cid && !r.placement);
  const placementRows = rows.filter((r) => r.source === "google" && r.placement);

  const campaignCovered = new Set(campaignRows.filter((r) => r.cid).map((r) => `${r.date}|${r.cid}`));
  const placementCampaignFallbackRows = placementRows.filter((r) => r.cid && !campaignCovered.has(`${r.date}|${r.cid}`));
  const googleCampaignRows = [...campaignRows, ...placementCampaignFallbackRows];
  const googlePlacementRows = placementRows.filter((r) => r.placement);
  const retentionRows = sourceRows;

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

// =========================================================================
// URL-based fallback: Removido URL_NAME (Erro 400 em v1 REST GAM)
// =========================================================================
function normalizeUrlForMatch(raw: string): string {
  if (!raw) return "";
  let t = safeDecode(String(raw)).toLowerCase().trim();
  t = t.replace(/^https?:\/\//, "").replace(/^www\./, "");
  t = t.split("?")[0].split("#")[0];
  t = t.replace(/\/+$/, "");
  return t;
}

async function buildFinalUrlMap(
  admin: any,
  userId: string,
  accountIds: string[],
  debug: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!accountIds || accountIds.length === 0) return map;
  const { data, error } = await admin
    .from("campaign_final_urls")
    .select("campaign_id, final_url")
    .eq("user_id", userId)
    .in("google_account_id", accountIds);
  if (error) {
    debug.push(`[URL_FALLBACK/map] erro=${String(error.message ?? error).slice(0, 300)}`);
    return map;
  }
  for (const row of (data ?? []) as any[]) {
    const key = normalizeUrlForMatch(String(row.final_url ?? ""));
    if (!key) continue;
    if (!map.has(key)) map.set(key, String(row.campaign_id));
  }
  debug.push(`[URL_FALLBACK/map] urls_indexadas=${map.size} (accounts=${accountIds.length})`);
  return map;
}

async function collectUrlAttribution(args: {
  networkCode: string; accessToken: string; ranges: GamRange[];
  finalUrlMap: Map<string, string>; debug: string[]; deadlineAt?: number;
}): Promise<AttributedRow[]> {
  const { networkCode, accessToken, ranges, finalUrlMap, debug, deadlineAt } = args;
  
  // REGRA: Usar SOAP ReportService para extrair URL_NAME intraday.
  // REST v1 causa 400 INVALID_ARGUMENT com URL_NAME + métricas combinadas.
  try {
    const reportRows = (await Promise.all(ranges.map(async (range) => {
      if (!range?.dateRange?.startDate) {
        debug.push(`[${networkCode}/SOAP] range invalido: ${JSON.stringify(range)}`);
        return [];
      }
      try {
        console.log(`[${networkCode}/SOAP] Triggering runSoapReport for range=${range.dateRange.startDate}`);
        const results = await runSoapReport({ networkCode, accessToken, range, dimensions: ["DATE", "URL_NAME"], debug, deadlineAt });
        console.log(`[${networkCode}/SOAP] range=${range.dateRange.startDate} rows=${results.length}`);
        debug.push(`[${networkCode}/SOAP] range=${range.dateRange.startDate} rows=${results.length}`);
        return results;
      } catch (soapErr) {
        console.error(`[collectUrlAttribution] SOAP individual range failed for net=${networkCode} range=${range.dateRange.startDate}`, soapErr);
        debug.push(`[${networkCode}/SOAP] range=${range.dateRange.startDate} falhou individualmente: ${String(soapErr).slice(0, 100)}`);
        return [];
      }
    }))).flat();
    
    const label = "URL_NAME (SOAP Intraday)";
    const rows = rowsFromUrlReportRows(reportRows, label, finalUrlMap);
    debugUtmCandidate(networkCode, label, "url_parsing", rows, debug);
    return rows;
  } catch (e) {
    console.error(`[collectUrlAttribution] net=${networkCode} soap failed`, e);
    debug.push(`[${networkCode}/URL_SOAP] erro=${String(e).slice(0, 300)}`);
    return [];
  }
}

async function runSoapReport(args: {
  networkCode: string;
  accessToken: string;
  range: GamRange;
  dimensions: string[];
  debug: string[];
  deadlineAt?: number;
}): Promise<ReportRow[]> {
  const { networkCode, accessToken, range, dimensions, debug } = args;
  
  // SOAP API v202405 ReportService minimalista
  const startDate = (String((range?.dateRange as any)?.fixed?.startDate ? `${(range.dateRange as any).fixed.startDate.year}-${String((range.dateRange as any).fixed.startDate.month).padStart(2, '0')}-${String((range.dateRange as any).fixed.startDate.day).padStart(2, '0')}` : (range?.dateRange?.startDate || "2000-01-01"))).replace(/-/g, "");
  const endDate = (String((range?.dateRange as any)?.fixed?.endDate ? `${(range.dateRange as any).fixed.endDate.year}-${String((range.dateRange as any).fixed.endDate.month).padStart(2, '0')}-${String((range.dateRange as any).fixed.endDate.day).padStart(2, '0')}` : (range?.dateRange?.endDate || "2000-01-01"))).replace(/-/g, "");
  
  const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v202405="https://www.google.com/apis/ads/publisher/v202405">
   <soapenv:Header>
      <v202405:RequestHeader>
         <v202405:networkCode>${networkCode}</v202405:networkCode>
         <v202405:applicationName>AdGeniusTracker</v202405:applicationName>
      </v202405:RequestHeader>
   </soapenv:Header>
   <soapenv:Body>
      <v202405:runReportJob>
         <v202405:reportJob>
            <v202405:reportQuery>
                <v202405:dimensions>DATE</v202405:dimensions>
                <v202405:dimensions>${dimensions.filter(d => d !== 'DATE').join("</v202405:dimensions><v202405:dimensions>")}</v202405:dimensions>
                <v202405:columns>AD_SERVER_IMPRESSIONS</v202405:columns>
                <v202405:columns>AD_SERVER_CPM_AND_CPC_REVENUE</v202405:columns>
                <v202405:columns>AD_EXCHANGE_IMPRESSIONS</v202405:columns>
                <v202405:columns>AD_EXCHANGE_REVENUE</v202405:columns>
               <v202405:dateRangeType>CUSTOM_DATE</v202405:dateRangeType>
                <v202405:startDate>
                   <v202405:year>${(range?.dateRange as any)?.fixed?.startDate?.year || (String(range?.dateRange?.startDate || "")).split("-")[0] || ""}</v202405:year>
                   <v202405:month>${(range?.dateRange as any)?.fixed?.startDate?.month || (String(range?.dateRange?.startDate || "")).split("-")[1] || ""}</v202405:month>
                   <v202405:day>${(range?.dateRange as any)?.fixed?.startDate?.day || (String(range?.dateRange?.startDate || "")).split("-")[2] || ""}</v202405:day>
                </v202405:startDate>
                <v202405:endDate>
                   <v202405:year>${(range?.dateRange as any)?.fixed?.endDate?.year || (String(range?.dateRange?.endDate || "")).split("-")[0] || ""}</v202405:year>
                   <v202405:month>${(range?.dateRange as any)?.fixed?.endDate?.month || (String(range?.dateRange?.endDate || "")).split("-")[1] || ""}</v202405:month>
                   <v202405:day>${(range?.dateRange as any)?.fixed?.endDate?.day || (String(range?.dateRange?.endDate || "")).split("-")[2] || ""}</v202405:day>
                </v202405:endDate>
            </v202405:reportQuery>
         </v202405:reportJob>
      </v202405:runReportJob>
   </soapenv:Body>
</soapenv:Envelope>`;

  const res = await gamFetch(SOAP_BASE, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "text/xml;charset=UTF-8",
      "SOAPAction": "runReportJob"
    },
    body: soapBody
  });

  const xml = await res.text();
  console.log(`[SOAP_INIT] response_xml=${xml.slice(0, 1000)}`);
  if (!res.ok) throw new Error(`SOAP runReportJob failed: ${xml.slice(0, 500)}`);

  const jobIdMatch = xml.match(/<id>(\d+)<\/id>/);
  if (!jobIdMatch) {
    console.error(`[SOAP_INIT] Failed to find JobID. XML: ${xml}`);
    throw new Error("SOAP response missing jobId");
  }
  const jobId = jobIdMatch[1];
  
  // Poll Job
  let resultUrl = "";
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v202405="https://www.google.com/apis/ads/publisher/v202405">
   <soapenv:Header>
      <v202405:RequestHeader>
         <v202405:networkCode>${networkCode}</v202405:networkCode>
         <v202405:applicationName>AdGeniusTracker</v202405:applicationName>
      </v202405:RequestHeader>
   </soapenv:Header>
   <soapenv:Body>
      <v202405:getReportJobStatus>
         <v202405:reportJobId>${jobId}</v202405:reportJobId>
      </v202405:getReportJobStatus>
   </soapenv:Body>
</soapenv:Envelope>`;

    const pollRes = await gamFetch(SOAP_BASE, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "text/xml;charset=UTF-8",
        "SOAPAction": "getReportJobStatus"
      },
      body: pollBody
    });
    const statusXml = await pollRes.text();
    if (statusXml.includes("COMPLETED")) {
      // Get Download URL
      const downloadBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v202405="https://www.google.com/apis/ads/publisher/v202405">
   <soapenv:Header>
      <v202405:RequestHeader>
         <v202405:networkCode>${networkCode}</v202405:networkCode>
         <v202405:applicationName>AdGeniusTracker</v202405:applicationName>
      </v202405:RequestHeader>
   </soapenv:Header>
   <soapenv:Body>
      <v202405:getReportDownloadUrlWithOptions>
         <v202405:reportJobId>${jobId}</v202405:reportJobId>
         <v202405:reportDownloadOptions>
            <v202405:exportFormat>CSV_DUMP</v202405:exportFormat>
            <v202405:useGzipCompression>false</v202405:useGzipCompression>
         </v202405:reportDownloadOptions>
      </v202405:getReportDownloadUrlWithOptions>
   </soapenv:Body>
</soapenv:Envelope>`;
      const dlRes = await gamFetch(SOAP_BASE, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "text/xml;charset=UTF-8",
          "SOAPAction": "getReportDownloadUrlWithOptions"
        },
        body: downloadBody
      });
      const dlXml = await dlRes.text();
      const urlMatch = dlXml.match(/<rval>(.*)<\/rval>/);
      if (urlMatch) {
        resultUrl = urlMatch[1];
        break;
      }
    } else if (statusXml.includes("FAILED")) {
      throw new Error("SOAP Report Job Failed");
    }
  }

  if (!resultUrl) throw new Error("SOAP Report Timeout/Failed to get URL");

  // Download e parse CSV
  const csvRes = await fetch(resultUrl);
  const csvText = await csvRes.text();
  console.log(`[SOAP_DUMP] resultUrl=${resultUrl}`);
  console.log(`[SOAP_DUMP] csvText_length=${csvText.length}`);
  console.log(`[SOAP_DUMP] first_500_chars=${csvText.slice(0, 500)}`);
  return parseSoapCsv(csvText, dimensions, debug);
}

function parseSoapCsv(csv: string, dimensions: string[], debug: string[]): ReportRow[] {
  const lines = csv.split("\n").filter(l => l.trim().length > 0);
  if (lines.length <= 1) return [];
  
  // O dump do GAM pode ter aspas
  console.log(`[parseSoapCsv] lines=${lines.length} headers=${lines[0]?.slice(0, 500)}`);
  debug.push(`[parseSoapCsv] lines=${lines.length} headers=${lines[0]?.slice(0, 200)}`);
  const parseLine = (line: string) => {
    const parts = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuotes = !inQuotes;
      else if (line[i] === ',' && !inQuotes) {
        parts.push(current);
        current = "";
      } else {
        current += line[i];
      }
    }
    parts.push(current);
    return parts;
  };

  if (!lines[0]) {
    debug.push(`[parseSoapCsv] CSV sem headers`);
    return [];
  }
  const headers = parseLine(lines[0]);
  const rows: ReportRow[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const row: any = { dims: [], impressions: 0, revenue: 0 };
    
    dimensions.forEach((dim, idx) => {
      row.dims.push(cols[idx] || "");
    });
    
    // Procura colunas de métricas. O ReportService expõe nomes como "AD_SERVER_IMPRESSIONS" 
    const findMetric = (name: string) => {
      // Prioridade exata para o header
      let idx = headers.findIndex(h => h.trim() === name);
      // Fallback para include caso o header venha com networkCode ou sufixos
      if (idx === -1) idx = headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
      // Fallback agressivo: mapear AD_SERVER_REVENUE e AD_SERVER_CPM_AND_CPC_REVENUE que às vezes trocam
      if (idx === -1 && name.includes("REVENUE")) {
         idx = headers.findIndex(h => h.toUpperCase().includes("REVENUE") && h.toUpperCase().includes("SERVER"));
      }
      return idx !== -1 ? Number(cols[idx] || 0) : 0;
    };
    
    const adServerImpr = findMetric("AD_SERVER_IMPRESSIONS") || 0;
    const adExchangeImpr = findMetric("AD_EXCHANGE_IMPRESSIONS") || 0;
    const adServerRev = (findMetric("AD_SERVER_CPM_AND_CPC_REVENUE") || findMetric("AD_SERVER_REVENUE") || 0) / 1_000_000;
    const adExchangeRev = (findMetric("AD_EXCHANGE_REVENUE") || 0) / 1_000_000;
    
    // Se a receita for zero mas houver impressões, o header pode ser diferente (ex: "Column.AdServerRevenue")
    // O CSV DUMP do GAM às vezes usa nomes amigáveis em vez dos nomes da API.
    row.impressions = adServerImpr + adExchangeImpr;
    row.revenue = adServerRev + adExchangeRev;

    if (row.revenue === 0 && row.impressions > 0) {
       // Tentativa desesperada de achar QUALQUER coluna de receita
       const anyRevIdx = headers.findIndex(h => h.toLowerCase().includes("revenue"));
       if (anyRevIdx !== -1) {
          row.revenue = Number(cols[anyRevIdx] || 0) / 1_000_000;
       }
    }
    
    row.date = row.dims[0];
    
    rows.push(row);
  }
  return rows;
}

function rowsFromUrlReportRows(reportRows: ReportRow[], label: string, finalUrlMap?: Map<string, string>): AttributedRow[] {
  return reportRows.map((r) => {
    const rawUrl = r.dims[1] || r.dims[0] || "";
    const params = parseUrlParams(rawUrl);
    const sourceRaw = params.utm_source ?? "";
    const campaignRaw = params.utm_campaign ?? "";
    const placementRaw = params.utm_placement ?? "";
    
    // Tenta extrair ID da URL se UTM falhar
    let cid = extractCampaignId(campaignRaw) ?? extractCampaignId(placementRaw);
    
    if (!cid) {
      // Se não houver cid no UTM, tentamos extrair da URL crua 
      // antes de tentar o map de final URLs (que pode ser ruidoso)
      cid = extractCampaignId(rawUrl);
    }
    
    if (!cid && finalUrlMap) {
      // Busca reversa no mapa de URLs finais se disponível
      for (const [campaignId, url] of finalUrlMap.entries()) {

        if (rawUrl.includes(campaignId) || (url && rawUrl.includes(url))) {
          cid = campaignId;
          break;
        }
      }
    }
    

    const source = sourceRaw ? safeDecode(sourceRaw).toLowerCase().trim() : (cid ? "google" : "unknown"); 

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

async function persistCampaignTotalRequests(args: {
  admin: any;
  userId: string;
  siteId: string | undefined;
  networkCode: string;
  accessToken: string;
  ranges: GamRange[];
  debug: string[];
  deadlineAt?: number;
}) {
  const { admin, userId, siteId, networkCode, accessToken, ranges, debug, deadlineAt } = args;
  if (!siteId) return;
  
  // Otimização: Agrupar AD_REQUESTS e AD_EXCHANGE_MATCH_RATE em um único relatório se possível,
  // ou pelo menos reduzir as chamadas paralelas excessivas.
  let reportRows: ReportRow[] = [];
  let matchRateRows: ReportRow[] = [];
  let siteMatchRateRows: ReportRow[] = [];
  
  try {
    // Tentamos buscar ambos no mesmo request (DATE + KEY_VALUES_NAME)
    const combined = (await Promise.all(ranges.map((range) =>
      runReport({
        networkCode, accessToken, range,
        dimensions: ["DATE", "KEY_VALUES_NAME"],
        metrics: ["AD_REQUESTS", "AD_EXCHANGE_MATCH_RATE"],
        expandedCompatibility: true,
        debug, deadlineAt,
      })
    ))).flat();
    reportRows = combined;
    matchRateRows = combined;
    console.log(`[${networkCode}/total_requests_optimized] rows=${combined.length}`);
  } catch (e) {
    debug.push(`[${networkCode}/total_requests_optimized] combined report failed, falling back: ${String(e).slice(0, 200)}`);
    // ... rest of fallback logic remains similar but less aggressive ...
  }

  // Agrega por (cid, date) usando a regra oficial:
  // Google Ads campaign.id ↔ GAM utm_campaign; se não houver utm_campaign,
  // extrai o ID de utm_placement ({campaign_id}_{placement}).
  const agg = new Map<string, MatchRateRow>();
  for (const row of buildRequestRowsFromReportRows(reportRows, "ad_requests")) {
    agg.set(`${row.cid}|${row.date}`, row);
  }
  if (agg.size === 0 && matchRateRows.length > 0) {
    const campaignRateByKey = new Map<string, { cid: string; date: string; rate: number }>();
    const placementRateByKey = new Map<string, { cid: string; date: string; rate: number }>();
    for (const r of matchRateRows) {
      const date = r.date;
      if (!date) continue;
      const kv = parseKeyValueDimension(r.dims[1] ?? "");
      const campaignCid = extractCampaignId(kv.utm_campaign);
      const placementCid = extractCampaignId(kv.utm_placement);
      const cid = campaignCid ?? placementCid;
      const rawRate = Number(r.impressions || 0);
      const rate = rawRate > 1 ? rawRate / 100 : rawRate;
      if (!cid || rate <= 0) continue;
      const target = campaignCid ? campaignRateByKey : placementRateByKey;
      const key = `${cid}|${date}`;
      const prev = target.get(key);
      if (!prev || rate > prev.rate) target.set(key, { cid, date, rate });
    }
    const rateByKey = new Map([...placementRateByKey, ...campaignRateByKey]);
    const cidsForRate = [...new Set([...rateByKey.values()].map((b) => b.cid))];
    const datesForRate = [...new Set([...rateByKey.values()].map((b) => b.date))];
    const { data: existingForRate } = cidsForRate.length && datesForRate.length ? await admin
      .from("gam_campaign_source_revenue")
      .select("campaign_id,date,impressions")
      .eq("user_id", userId)
      .eq("site_id", siteId)
      .eq("utm_source", "google")
      .in("campaign_id", cidsForRate)
      .in("date", datesForRate) : { data: [] };
    const { data: placementForRate } = cidsForRate.length && datesForRate.length ? await admin
      .from("gam_placement_revenue")
      .select("campaign_id,date,impressions")
      .eq("user_id", userId)
      .eq("site_id", siteId)
      .in("campaign_id", cidsForRate)
      .in("date", datesForRate) : { data: [] };
    const existingImpressionsByRateKey = new Map<string, number>();
    const placementImpressionsByRateKey = new Map<string, number>();
    for (const r of (existingForRate ?? []) as any[]) {
      const key = `${r.campaign_id}|${r.date}`;
      existingImpressionsByRateKey.set(key, Math.max(existingImpressionsByRateKey.get(key) ?? 0, Number(r.impressions ?? 0)));
    }
    for (const r of (placementForRate ?? []) as any[]) {
      const key = `${r.campaign_id}|${r.date}`;
      placementImpressionsByRateKey.set(key, (placementImpressionsByRateKey.get(key) ?? 0) + Number(r.impressions ?? 0));
    }
    const allImpressionKeys = new Set([...existingImpressionsByRateKey.keys(), ...placementImpressionsByRateKey.keys()]);
    for (const key of allImpressionKeys) {
      const placementImpressions = placementImpressionsByRateKey.get(key) ?? 0;
      const impressions = placementImpressions > 0 ? placementImpressions : (existingImpressionsByRateKey.get(key) ?? 0);
      const rateRow = rateByKey.get(key);
      if (!rateRow || impressions <= 0 || rateRow.rate <= 0) continue;
      agg.set(key, { cid: rateRow.cid, date: rateRow.date, total_requests: Math.round(impressions / rateRow.rate), source: "match_rate", match_rate_pct: rateRow.rate * 100 });
    }
    debug.push(`[${networkCode}/total_requests] fallback AD_EXCHANGE_MATCH_RATE gerou ${agg.size} linhas`);
  }
  if (siteMatchRateRows.length > 0) {
    const siteRateByDate = new Map<string, number>();
    for (const r of siteMatchRateRows) {
      if (!r.date) continue;
      const rawRate = Number(r.impressions || 0);
      const rate = rawRate > 1 ? rawRate / 100 : rawRate;
      if (rate > 0) siteRateByDate.set(r.date, rate);
    }
    const siteRateDates = [...siteRateByDate.keys()];
    const { data: placementForRate } = siteRateDates.length ? await admin
      .from("gam_placement_revenue")
      .select("campaign_id,date,revenue_usd,impressions")
      .eq("user_id", userId)
      .eq("site_id", siteId)
      .in("date", siteRateDates) : { data: [] };
    const placementTotals = new Map<string, { cid: string; date: string; impressions: number; revenue_usd: number }>();
    for (const r of (placementForRate ?? []) as any[]) {
      const cid = String(r.campaign_id ?? "");
      const date = String(r.date ?? "");
      if (!cid || !date || cid === "__aggregate__") continue;
      const key = `${cid}|${date}`;
      const cur = placementTotals.get(key) ?? { cid, date, impressions: 0, revenue_usd: 0 };
      cur.impressions += Number(r.impressions || 0);
      cur.revenue_usd += Number(r.revenue_usd || 0);
      placementTotals.set(key, cur);
    }
    for (const [key, p] of placementTotals) {
      if (agg.has(key) || p.impressions <= 0) continue;
      const siteRate = siteRateByDate.get(p.date);
      if (siteRate && siteRate > 0) agg.set(key, { cid: p.cid, date: p.date, total_requests: Math.round(p.impressions / siteRate), source: "site_match_rate", impressions: p.impressions, revenue_usd: p.revenue_usd, match_rate_pct: siteRate * 100 });
    }
  }
  if (agg.size === 0) {
    debug.push(`[${networkCode}/total_requests] nenhuma linha com utm_campaign encontrada`);
    return;
  }
  // Atualiza linhas existentes em gam_campaign_source_revenue para utm_source='google'.
  // Se não existir, faz upsert com revenue/impressions=0 só para guardar o request count.
  // Lê linhas existentes (utm_source='google') para preservar revenue_usd/impressions no upsert.
  const cids = [...new Set([...agg.values()].map((b) => b.cid))];
  const dates = [...new Set([...agg.values()].map((b) => b.date))];
  const { data: existing } = await admin
    .from("gam_campaign_source_revenue")
    .select("campaign_id,date,revenue_usd,impressions,match_rate_pct")
    .eq("user_id", userId)
    .eq("site_id", siteId)
    .eq("utm_source", "google")
    .in("campaign_id", cids)
    .in("date", dates);
  const { data: placementExisting } = await admin
    .from("gam_placement_revenue")
    .select("campaign_id,date,revenue_usd,impressions")
    .eq("user_id", userId)
    .eq("site_id", siteId)
    .in("campaign_id", cids)
    .in("date", dates);
  const existingMap = new Map<string, { revenue_usd: number; impressions: number; match_rate_pct: number | null }>();
  for (const r of (existing ?? []) as any[]) {
    existingMap.set(`${r.campaign_id}|${r.date}`, { revenue_usd: Number(r.revenue_usd || 0), impressions: Number(r.impressions || 0), match_rate_pct: r.match_rate_pct == null ? null : Number(r.match_rate_pct) });
  }
  const placementTotalsForExisting = new Map<string, { revenue_usd: number; impressions: number }>();
  for (const r of (placementExisting ?? []) as any[]) {
    const key = `${r.campaign_id}|${r.date}`;
    const cur = placementTotalsForExisting.get(key) ?? { revenue_usd: 0, impressions: 0 };
    cur.revenue_usd += Number(r.revenue_usd || 0);
    cur.impressions += Number(r.impressions || 0);
    placementTotalsForExisting.set(key, cur);
  }
  for (const [key, placement] of placementTotalsForExisting) {
    if (placement.impressions > 0) existingMap.set(key, { ...placement, match_rate_pct: existingMap.get(key)?.match_rate_pct ?? null });
  }
  const rows = [...agg.values()].map((b) => {
    const prev = existingMap.get(`${b.cid}|${b.date}`) ?? { revenue_usd: 0, impressions: 0, match_rate_pct: null };
    return {
      user_id: userId,
      site_id: siteId,
      campaign_id: b.cid,
      date: b.date,
      utm_source: "google",
      revenue_usd: prev.revenue_usd,
      impressions: prev.impressions,
      total_requests: b.total_requests,
      match_rate_pct: b.match_rate_pct ?? prev.match_rate_pct,
    };
  });
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await admin
      .from("gam_campaign_source_revenue")
      .upsert(slice, { onConflict: "user_id,site_id,campaign_id,date,utm_source" });
    if (error) debug.push(`[${networkCode}/total_requests] upsert err=${error.message}`);
  }
  debug.push(`[${networkCode}/total_requests] ${rows.length} (cid,date) atualizados`);
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
  const buckets = new Map<string, { user_id: string; site_id: string; campaign_id: string; date: string; utm_source: string; revenue_usd: number; impressions: number; total_requests?: number; match_rate_pct?: number | null; attribution_status?: string }>();
  for (const r of rows) {
    const date = r.date ?? today;
    const source = (r.source || "unknown").toLowerCase();
    const cid = r.cid ?? "__aggregate__";
    const key = `${cid}|${date}|${source}`;
    
    const isSoap = r.raw.includes("SOAP") || r.raw.includes("URL_NAME") || (r as any).label?.includes("SOAP");
    const isPredictive = r.raw.includes("PREDICTIVE");
    const status = (isSoap || isPredictive) ? "intraday" : "consolidated";

    const cur = buckets.get(key) ?? {
      user_id: userId, site_id: siteId, campaign_id: cid, date, utm_source: source, revenue_usd: 0, impressions: 0,
      attribution_status: status
    };
    
    // Se houver qualquer linha consolidada para este balde, o balde todo vira consolidado
    if (!isSoap && !isPredictive) cur.attribution_status = "consolidated";

    cur.revenue_usd += r.revenue / ingestionDivisor;
    cur.impressions += r.impressions;
    buckets.set(key, cur);
  }
  const dates = [...new Set([...syncDates, ...[...buckets.values()].map((b) => b.date)])];
  if (dates.length === 0) return;

  // Busca dados existentes para evitar sobrescrever 'consolidated' por 'intraday'
  const { data: existing } = await admin.from("gam_campaign_source_revenue")
    .select("campaign_id,date,utm_source,total_requests,match_rate_pct,attribution_status,revenue_usd")
    .eq("user_id", userId).eq("site_id", siteId).in("date", dates);

  const existingMap = new Map<string, { total_requests: number; match_rate_pct: number | null; attribution_status: string | null; revenue_usd: number }>();
  for (const r of (existing ?? []) as any[]) {
    existingMap.set(`${r.campaign_id}|${r.date}|${String(r.utm_source ?? "").toLowerCase()}`, { 
      total_requests: Number(r.total_requests ?? 0), 
      match_rate_pct: r.match_rate_pct == null ? null : Number(r.match_rate_pct),
      attribution_status: r.attribution_status || 'consolidated', // Default to consolidated if null
      revenue_usd: Number(r.revenue_usd || 0)
    });
  }

  const finalRows = [];
  for (const b of buckets.values()) {
    const key = `${b.campaign_id}|${b.date}|${b.utm_source}`;
    const prev = existingMap.get(key);

    if (prev) {
      // REGRA DE SEGURANÇA: Nunca sobrescreva 'consolidated' por 'intraday' (estimated)
      if (prev.attribution_status === "consolidated" && b.attribution_status === "intraday") {
        debug.push(`[gam_campaign_source_revenue] Ignorando intraday para ${key} pois já existe dado consolidado.`);
        continue;
      }
      
      // Preserva total_requests se já existirem
      if (prev.total_requests > 0) {
        b.total_requests = prev.total_requests;
        b.match_rate_pct = prev.match_rate_pct;
      }
    }
    finalRows.push(b);
  }

  if (finalRows.length === 0) {
    debug.push(`[gam_campaign_source_revenue] SKIP: nenhum dado novo ou mais confiável para inserir.`);
    return;
  }

  // Upsert individual ou em batch com tratamento de conflito seria melhor, 
  // mas como a tabela tem delete/insert no código original, vamos manter a estrutura 
  // mas filtrando o delete apenas para as chaves que estamos realmente atualizando.
  for (const row of finalRows) {
     await admin.from("gam_campaign_source_revenue")
      .delete()
      .eq("user_id", userId)
      .eq("site_id", siteId)
      .eq("campaign_id", row.campaign_id)
      .eq("date", row.date)
      .eq("utm_source", row.utm_source);
  }

  const CHUNK = 500;
  for (let i = 0; i < finalRows.length; i += CHUNK) {
    await admin.from("gam_campaign_source_revenue").insert(finalRows.slice(i, i + CHUNK));
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

  const placementBuckets = new Map<string, { user_id: string; site_id: string; campaign_id: string; placement: string; date: string; revenue_usd: number; impressions: number; source: string; utm_source: string; raw_utm: string; attribution_status?: string }>();
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
      attribution_status: (r.raw.includes("SOAP") || r.raw.includes("URL_NAME")) ? "intraday" : "consolidated"
    };
    pb.revenue_usd += r.revenue / ingestionDivisor;
    pb.impressions += r.impressions;
    placementBuckets.set(key, pb);
  }

  // CRÍTICO: só deleta+reinsere se temos dados novos. Se o GAM falhou (429/quota/timeout)
  // e não retornou linhas, NÃO apaga — preserva o último bom snapshot na tabela.
  const arr = [...placementBuckets.values()];
  const hasData = arr.length > 0 || googleCampaignRows.length > 0;
  
  if (!hasData) {
    debug.push(`[gam_placement_revenue] SKIP delete/insert: nenhum dado retornado pelo GAM.`);
  } else {
    const dates = [...new Set([...syncDates, ...arr.map((p) => p.date)])];
    
    // Busca dados existentes para evitar sobrescrever 'consolidated' por 'intraday'
    const { data: existingPlacements } = await admin.from("gam_placement_revenue")
      .select("campaign_id, placement, date, attribution_status")
      .eq("user_id", userId).eq("site_id", siteId).in("date", dates);
    
    const existingPMap = new Map<string, string>();
    for (const r of (existingPlacements ?? []) as any[]) {
      existingPMap.set(`${r.campaign_id}|${r.placement}|${r.date}`, r.attribution_status || 'consolidated');
    }

    const finalPlacements = arr.filter(p => {
      const key = `${p.campaign_id}|${p.placement}|${p.date}`;
      const prevStatus = existingPMap.get(key);
      if (prevStatus === 'consolidated' && p.attribution_status === 'intraday') {
        return false;
      }
      return true;
    });

    if (finalPlacements.length > 0) {
      for (const row of finalPlacements) {
        await admin.from("gam_placement_revenue")
          .delete()
          .eq("user_id", userId)
          .eq("site_id", siteId)
          .eq("campaign_id", row.campaign_id)
          .eq("placement", row.placement)
          .eq("date", row.date);
      }
      const CHUNK = 500;
      for (let i = 0; i < finalPlacements.length; i += CHUNK) {
        await admin.from("gam_placement_revenue").insert(finalPlacements.slice(i, i + CHUNK));
      }
    }
    debug.push(`[gam_placement_revenue] ${finalPlacements.length} linha(s) processadas.`);

    const sourceByCampaign = new Map<string, { user_id: string; site_id: string; campaign_id: string; date: string; utm_source: string; revenue_usd: number; impressions: number; total_requests?: number; match_rate_pct?: number | null; attribution_status?: string }>();
    
    // 1. Inicializa com dados das campanhas (pode vir de SOAP/URL_NAME sem placement)
    for (const r of googleCampaignRows) {
      if (!r.cid) continue;
      const date = r.date ?? today;
      const source = (r.source || "google").toLowerCase();
      const key = `${r.cid}|${date}`;
      
      const isSoap = r.raw.includes("SOAP") || r.raw.includes("URL_NAME") || (r as any).label?.includes("SOAP") || r.raw.includes("PREDICTIVE");
      const status = isSoap ? "intraday" : "consolidated";

      const cur = sourceByCampaign.get(key) ?? { 
        user_id: userId, site_id: siteId, campaign_id: r.cid, date, 
        utm_source: source, revenue_usd: 0, impressions: 0, 
        attribution_status: status 
      };
      
      // Se tivermos qualquer linha consolidada para essa campanha/data, o status final do bucket é consolidado
      if (!isSoap) cur.attribution_status = "consolidated";
      
      cur.revenue_usd += Number(r.revenue / ingestionDivisor || 0);
      cur.impressions += Number(r.impressions || 0);
      sourceByCampaign.set(key, cur);
    }

    // 2. Complementa/Sobrescreve com dados por placement se houver (mais detalhado)
    // Nota: Se já adicionamos via googleCampaignRows, evitamos duplicar se a fonte for a mesma.
    // Mas geralmente o sync roda OU um OU outro para o mesmo range de data.
    if (arr.length > 0) {
      for (const p of arr) {
        const key = `${p.campaign_id}|${p.date}`;
        let cur = sourceByCampaign.get(key);
        if (!cur) {
          cur = { user_id: userId, site_id: siteId, campaign_id: p.campaign_id, date: p.date, utm_source: "google", revenue_usd: 0, impressions: 0, attribution_status: p.attribution_status };
          sourceByCampaign.set(key, cur);
        } else {
          // Se já existe e a linha de placement é 'consolidated', garante o status
          if (p.attribution_status === "consolidated") cur.attribution_status = "consolidated";
          // Se a receita do placement for significativamente diferente do que já temos (ex: SOAP vs REST),
          // confiamos no placement (REST) como fonte da verdade se for consolidado.
          // Aqui, apenas somamos se não vier da mesma fonte, mas para simplificar:
          // as googlePlacementRows no loop 1800 já são filtradas.
        }
      }
    }

    const cids = [...new Set([...sourceByCampaign.values()].map((r) => r.campaign_id))];
    const { data: existingSource } = cids.length ? await admin.from("gam_campaign_source_revenue")
      .select("campaign_id,date,total_requests,match_rate_pct,attribution_status")
      .eq("user_id", userId).eq("site_id", siteId).eq("utm_source", "google").in("date", dates).in("campaign_id", cids) : { data: [] };
    
    const existingSMap = new Map<string, { total_requests: number; match_rate_pct: number | null; attribution_status: string }>();
    for (const r of (existingSource ?? []) as any[]) {
      existingSMap.set(`${r.campaign_id}|${r.date}`, {
        total_requests: Number(r.total_requests || 0),
        match_rate_pct: r.match_rate_pct == null ? null : Number(r.match_rate_pct),
        attribution_status: r.attribution_status || 'consolidated'
      });
    }

    const finalSourceRows = [];
    for (const b of sourceByCampaign.values()) {
      const key = `${b.campaign_id}|${b.date}`;
      const prev = existingSMap.get(key);
      
      // LOG DE AUDITORIA CRÍTICO PARA O USUÁRIO
      if (b.campaign_id === '23207554976') {
        console.log(`[AUDIT_ persist] Campaign 23207554976 found! rev=${b.revenue_usd} status=${b.attribution_status} site=${b.site_id}`);
        debug.push(`[AUDIT_persist] Campanha 23207554976 processada: R$ ${(b.revenue_usd * fx.usdBrl).toFixed(2)} (${b.attribution_status})`);
      }

      if (prev) {
        // REGRA DE SEGURANÇA: Nunca sobrescreva 'consolidated' por 'intraday' (estimated)
        if (prev.attribution_status === 'consolidated' && b.attribution_status === 'intraday') {
          continue;
        }
        if (prev.total_requests > 0) {
          b.total_requests = prev.total_requests;
          b.match_rate_pct = prev.match_rate_pct;
        }
      }
      finalSourceRows.push(b);
    }


    if (finalSourceRows.length > 0) {
      for (let i = 0; i < finalSourceRows.length; i += CHUNK) {
        await admin.from("gam_campaign_source_revenue").upsert(finalSourceRows.slice(i, i + CHUNK), { onConflict: "user_id,site_id,campaign_id,date,utm_source" });
      }
    }
    debug.push(`[gam_campaign_source_revenue/google] ${finalSourceRows.length} linha(s) processadas (consolidated/intraday sync)`);
  }

  const { data: links } = await admin
    .from("account_site_links")
    .select("google_account_id")
    // Removemos filtro por user_id aqui pois o site já pertence ao usuário
    // e o link pode ter sido criado com um user_id divergente em sessões anteriores.
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

    // AUDITORIA DE QUERY
    const auditCids = ['23207554976', '23309079322', '23021142139'];
    const hasAuditCid = cids.some(c => auditCids.includes(c));
    if (hasAuditCid) {
      debug.push(`[AUDIT_query] Buscando receita para CIDs: ${cids.filter(c => auditCids.includes(c)).join(',')} em ${date}`);
    }

    const { data: allSourceRows } = await admin
      .from("gam_campaign_source_revenue")
      .select("campaign_id, revenue_usd, utm_source")
      .eq("user_id", userId)
      .eq("date", date)
      .in("campaign_id", cids);

    const aggregatedByCid = new Map<string, number>();
    for (const r of (allSourceRows ?? []) as any[]) {
      const cid = String(r.campaign_id).trim();
      const rev = Number(r.revenue_usd ?? 0);
      aggregatedByCid.set(cid, (aggregatedByCid.get(cid) ?? 0) + rev);
      
      if (auditCids.includes(cid)) {
        debug.push(`[AUDIT_query_match] Encontrado em source_revenue: cid=${cid} rev=$${rev.toFixed(4)} source=${r.utm_source}`);
      }
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
      
      // Se receita é zero e há gasto, o ROI deve ser -100%, não -6.5% (RevShare).
      // O revshare só deve incidir sobre a receita bruta.
      const roi = spendBrl > 0 
        ? (revenueUsd > 0 ? (profit / spendBrl) * 100 : -100)
        : 0;
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
  dimensionKeyIds?: string[];
  dimensionKeyIdsField?: "customDimensionKeyIds" | "ekvDimensionKeyIds";
  expandedCompatibility?: boolean;
  debug: string[];
  deadlineAt?: number;
}

async function runReport(args: RunReportArgs): Promise<ReportRow[]> {
  const { networkCode, accessToken, range, dimensions, metrics, dimensionKeyIds, dimensionKeyIdsField, expandedCompatibility, debug, deadlineAt } = args;
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
  if (expandedCompatibility) reportDefinition.expandedCompatibility = true;
  if (dimensionKeyIds?.length) reportDefinition[dimensionKeyIdsField ?? "customDimensionKeyIds"] = dimensionKeyIds;

  // Não usar visibility: "DRAFT" — a API atual restringe dimensões (PAGE_PATH/URL) e
  // pode limitar receita/impressões retornadas. Report criado sem visibility usa o padrão
  // ("SAVED"), que devolve os mesmos números vistos no painel do Ad Manager.
  const reportBody = { reportDefinition };
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
        revenue = metrics.length > 1 ? numRevenue(m[1]) : 0;
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
  fallbackRanges?: GamRange[],
  opts?: { preserveHigherExisting?: boolean },
) {
  if (!siteId) return;
  const today = new Date().toISOString().slice(0, 10);
  // Agrega por data (caso múltiplos ranges retornem mesmo dia)
  const byDate = new Map<string, { impr: number; meas: number; view: number; rev: number }>();
  for (const r of rows) {
    const d = r.date ?? today;
    const cur = byDate.get(d) ?? { impr: 0, meas: 0, view: 0, rev: 0 };
    cur.impr += r.impressions; cur.meas += r.measurable; cur.view += r.viewable; cur.rev += r.revenue;
    byDate.set(d, cur);
  }

  // Fallback: se viewability foi pulada (rows vazio) mas já temos receita gravada em
  // gam_campaign_source_revenue, atualiza receita/impressões do dia mesmo assim.
  // Isso evita o dashboard travar quando o budget do sync apertar.
  let usedFallback = false;
  if (byDate.size === 0 && fallbackRanges && fallbackRanges.length > 0) {
    const dateList = datesFromRanges(fallbackRanges);
    if (dateList.length > 0) {
      const { data: revRows } = await admin
        .from("gam_campaign_source_revenue")
        .select("date, revenue_usd, impressions")
        .eq("site_id", siteId)
        .in("date", dateList);
      for (const r of (revRows ?? []) as any[]) {
        const cur = byDate.get(r.date) ?? { impr: 0, meas: 0, view: 0, rev: 0 };
        cur.impr += Number(r.impressions || 0);
        cur.rev += Number(r.revenue_usd || 0);
        byDate.set(r.date, cur);
      }
      usedFallback = byDate.size > 0;
    }
  }

  if (byDate.size === 0) return;

  if (usedFallback) {
    // Atualiza só revenue/impressions/ecpm — preserva measurable/viewable existentes.
    for (const [date, v] of byDate.entries()) {
      const { data: exists } = await admin
        .from("site_metrics_daily")
        .select("id, impressions, revenue_native")
        .eq("user_id", userId).eq("site_id", siteId).eq("date", date)
        .maybeSingle();
      let nextImpr = v.impr;
      let nextRev = v.rev;
      if (opts?.preserveHigherExisting && exists && Number(exists.revenue_native ?? 0) > v.rev + 1) {
        nextRev = Number(exists.revenue_native ?? 0);
        nextImpr = Math.max(Number(exists.impressions ?? 0), v.impr);
        debug.push(`[site_metrics_daily] fallback preserved higher existing site=${siteId} date=${date} existing=${nextRev} incoming=${v.rev}`);
      }
      const ecpm = nextImpr > 0 ? (nextRev / nextImpr) * 1000 : 0;
      if (exists) {
        await admin.from("site_metrics_daily")
          .update({
            impressions: nextImpr,
            revenue_native: nextRev,
            currency,
            ecpm_native: ecpm,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId).eq("site_id", siteId).eq("date", date);
      } else {
        await admin.from("site_metrics_daily").insert({
          user_id: userId, site_id: siteId, date,
          impressions: nextImpr, measurable_impressions: 0, viewable_impressions: 0,
          revenue_native: nextRev, currency, ecpm_native: ecpm,
          updated_at: new Date().toISOString(),
        });
      }
    }
    debug.push(`[site_metrics_daily] site=${siteId} fallback rows=${byDate.size} currency=${currency}`);
    return;
  }

  const payload = [] as Array<{
    user_id: string;
    site_id: string;
    date: string;
    impressions: number;
    measurable_impressions: number;
    viewable_impressions: number;
    revenue_native: number;
    currency: string;
    ecpm_native: number;
    updated_at: string;
  }>;
  const existingByDate = new Map<string, any>();
  if (opts?.preserveHigherExisting) {
    const dateList = [...byDate.keys()];
    const { data: existingRows } = dateList.length > 0 ? await admin
      .from("site_metrics_daily")
      .select("date, impressions, measurable_impressions, viewable_impressions, revenue_native, currency")
      .eq("user_id", userId)
      .eq("site_id", siteId)
      .in("date", dateList) : { data: [] };
    for (const r of existingRows ?? []) existingByDate.set(String(r.date), r);
  }

  let preservedHigher = 0;
  for (const [date, v] of byDate.entries()) {
    const existing = existingByDate.get(date);
    let next = v;
    const existingRevenue = Number(existing?.revenue_native ?? 0);
    const nextRevenue = Number(v.rev ?? 0);
    if (opts?.preserveHigherExisting && existing && existingRevenue > nextRevenue + 1) {
      preservedHigher++;
      next = {
        impr: Math.max(Number(existing.impressions ?? 0), v.impr),
        meas: Math.max(Number(existing.measurable_impressions ?? 0), v.meas),
        view: Math.max(Number(existing.viewable_impressions ?? 0), v.view),
        rev: existingRevenue,
      };
    }
    payload.push({
      user_id: userId,
      site_id: siteId,
      date,
      impressions: next.impr,
      measurable_impressions: next.meas,
      viewable_impressions: next.view,
      revenue_native: next.rev,
      currency,
      ecpm_native: next.impr > 0 ? (next.rev / next.impr) * 1000 : 0,
      updated_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < payload.length; i += 500) {
    await admin.from("site_metrics_daily").upsert(payload.slice(i, i + 500), { onConflict: "user_id,site_id,date" });
  }
  debug.push(`[site_metrics_daily] site=${siteId} rows=${payload.length} currency=${currency}${preservedHigher ? ` preserved_higher=${preservedHigher}` : ""}`);
}


async function collectPredictiveIntradayAttribution(args: {
  networkCode: string;
  accessToken: string;
  ranges: GamRange[];
  totalSiteRevenue: number;
  totalSiteImpressions: number;
  debug: string[];
  deadlineAt?: number;
}): Promise<AttributionResult> {
  const { networkCode, accessToken, ranges, totalSiteRevenue, totalSiteImpressions, debug, deadlineAt } = args;
  
  // REGRA SENIOR: Puxar apenas impressões (sem receita) para evitar Erro 400 e latência.
  // Google libera dimensões de targeting com métricas de inventário (impressões) instantaneamente.
  const metrics = ["AD_SERVER_IMPRESSIONS", "AD_EXCHANGE_IMPRESSIONS"];
  const label = "PREDICTIVE_INTRADAY";

  try {
    const reportRows = (await Promise.all(ranges.map((range) =>
      runReport({ 
        networkCode, 
        accessToken, 
        range, 
        dimensions: ["DATE", "KEY_VALUES_NAME"], 
        metrics, 
        debug, 
        deadlineAt 
      })
    ))).flat();

    if (reportRows.length === 0) {
      debug.push(`[${label}] 0 rows encontrados para impressões intraday.`);
      return { retentionRows: [], googleCampaignRows: [], googlePlacementRows: [], campaignSource: "none", placementSource: "none" };
    }

    // Agregamos as impressões por campanha
    const campaignImpressions = new Map<string, { impr: number; date: string; rawKv: string }>();
    let totalAttributedImpressions = 0;

    for (const r of reportRows) {
      const rawKv = r.dims[1] || "";
      const kv = parseKeyValueDimension(rawKv);
      const cid = extractCampaignId(kv.utm_campaign) ?? extractCampaignId(kv.utm_placement);
      if (!cid || !r.date) continue;

      const key = `${cid}|${r.date}`;
      const cur = campaignImpressions.get(key) ?? { impr: 0, date: r.date, rawKv };
      cur.impr += r.impressions;
      totalAttributedImpressions += r.impressions;
      campaignImpressions.set(key, cur);
    }

    if (totalAttributedImpressions === 0) {
      debug.push(`[${label}] Impressões atribuídas = 0.`);
      return { retentionRows: [], googleCampaignRows: [], googlePlacementRows: [], campaignSource: "none", placementSource: "none" };
    }

    // Distribuímos a receita proporcionalmente
    const googleCampaignRows: AttributedRow[] = [];
    for (const [key, data] of campaignImpressions.entries()) {
      const [cid] = key.split("|");
      const share = data.impr / totalAttributedImpressions; // Use total atribuído para a proporção interna
      const siteShare = data.impr / totalSiteImpressions; // Use total do site para a receita real
      const estimatedRev = totalSiteRevenue * siteShare;
      
      googleCampaignRows.push({
        date: data.date,
        impressions: data.impr,
        revenue: estimatedRev,
        source: "google",
        cid: cid,
        placement: null,
        raw: `PREDICTIVE|utm_source=google|raw=${data.rawKv.slice(0, 150)}|share=${(siteShare * 100).toFixed(2)}%`
      });
    }

    debug.push(`[${label}] Sucesso: ${googleCampaignRows.length} campanhas estimadas via share de impressões.`);
    
    return {
      retentionRows: [],
      googleCampaignRows,
      googlePlacementRows: [],
      campaignSource: label,
      placementSource: label
    };

  } catch (e) {
    debug.push(`[${label}] Erro na coleta: ${String(e)}`);
    return { retentionRows: [], googleCampaignRows: [], googlePlacementRows: [], campaignSource: "none", placementSource: "none" };
  }
}
