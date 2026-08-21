// Sincroniza:
// 1) Sub-contas (customer_client) de cada MCC
// 2) Campanhas + métricas de cada conta não-manager
// 3) Auto-aplica final_url_suffix padrão em qualquer campanha que não tenha
// Spend fica na moeda nativa da conta Google Ads; receita vem somente do GAM.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { devTokenFor, getCreds } from "../_shared/google_api_set.ts";

const STANDARD_UTM_SUFFIX = [
  "utm_source=google",
  "utm_campaign={campaignid}",
  "utm_adgroup={adgroupid}",
  "utm_content={creative}",
  "utm_placement={campaignid}_{placement}",
].join("&");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Login obrigatório" });
    }

    // Date filter from request body
    let datePreset: string | null = null;
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    let accountIds: string[] = [];
    let windowDays: number | null = null;
    let bodyUserId: string | null = null;
    let bodySiteId: string | null = null;
    try {
      const body = await req.json().catch(() => ({}));
      if (body && typeof body === "object") {
        datePreset = (body as any).date_preset ?? null;
        dateFrom = (body as any).from ?? null;
        dateTo = (body as any).to ?? null;
        accountIds = Array.isArray((body as any).account_ids)
          ? (body as any).account_ids.filter((id: unknown) => typeof id === "string" && id.length > 0)
          : [];
        windowDays = typeof (body as any).window_days === "number" ? (body as any).window_days : null;
        bodyUserId = typeof (body as any).user_id === "string" ? (body as any).user_id : null;
        bodySiteId = typeof (body as any).site_id === "string" ? (body as any).site_id : null;
      }
    } catch (_) { /* no body */ }

    const ALLOWED_PRESETS = new Set(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS"]);
    let dateClause = "segments.date DURING LAST_30_DAYS";
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const token = authHeader.replace("Bearer ", "");
    let isServiceRole = token === SERVICE_ROLE;
    if (!isServiceRole) {
      try { const p = JSON.parse(atob(token.split(".")[1] ?? "")); if (p?.role === "service_role") isServiceRole = true; } catch { /* */ }
    }

    // Default to a narrow window for automated crons to save API quota
    if (isServiceRole && !windowDays && !datePreset && !dateFrom) {
       dateClause = "segments.date DURING TODAY";
    }

    if (windowDays) {
      const today = new Date();
      const startDate = new Date();
      startDate.setDate(today.getDate() - windowDays);
      const formatDate = (d: Date) => d.toISOString().split("T")[0].replace(/-/g, "");
      dateClause = `segments.date BETWEEN '${formatDate(startDate)}' AND '${formatDate(today)}'`;
    } else if (datePreset && ALLOWED_PRESETS.has(String(datePreset).toUpperCase())) {
      dateClause = `segments.date DURING ${String(datePreset).toUpperCase()}`;
    } else if (dateFrom && dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      dateClause = `segments.date BETWEEN '${dateFrom.replace(/-/g, "")}' AND '${dateTo.replace(/-/g, "")}'`;
    }

    let userId: string | undefined;
    if (isServiceRole) {
      const adminPre = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);
      if (bodyUserId) userId = bodyUserId;
      else if (bodySiteId) {
        const { data: s } = await adminPre.from("sites").select("user_id").eq("id", bodySiteId).maybeSingle();
        userId = s?.user_id ?? undefined;
      } else if (accountIds.length > 0) {
        const { data: ga } = await adminPre.from("google_accounts").select("user_id").eq("id", accountIds[0]).maybeSingle();
        userId = ga?.user_id ?? undefined;
      }
    } else {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
      );
      const { data: claims } = await userClient.auth.getClaims(token);
      userId = claims?.claims?.sub;
    }
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Busca todas as contas conectadas que estão habilitadas para sincronização
    const { data: accounts, error: accErr } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, is_mcc, account_name, descriptive_name, currency, login_customer_id, api_set, status")
      .eq("user_id", userId)
      .eq("sync_enabled", true)
      .not("refresh_token", "is", null);

    if (accErr) return json({ error: accErr.message });
    if (!accounts || accounts.length === 0) {
      return json({ error: "Nenhuma conta Google Ads conectada. Conecte primeiro." });
    }


    const summary: Array<Record<string, unknown>> = [];
    const debugLogs: string[] = [];
    const syncErrors: Array<{ account_id: string; error: string }> = [];

    // Helper for fetch with retry and backoff
    async function fetchWithRetry(url: string, init: RequestInit, attempts = 3, adminClient?: any, siteId?: string): Promise<Response> {
      let lastErr: any;
      for (let i = 0; i < attempts; i++) {
        try {
          // Check if we are within a blocked period from Google
          if (siteId && adminClient) {
             const { data: site } = await adminClient.from("sites").select("next_sync_allowed_at").eq("id", siteId).maybeSingle();
             if (site?.next_sync_allowed_at && new Date(site.next_sync_allowed_at) > new Date()) {
                const waitMs = new Date(site.next_sync_allowed_at).getTime() - Date.now();
                console.warn(`[sync-campaigns] Quota blocked. Next sync allowed in ${Math.round(waitMs/1000)}s. Skipping.`);
                return new Response(JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED", details: [{ quotaErrorDetail: { retryDelaySeconds: Math.round(waitMs/1000) } }] } }), { status: 429 });
             }
          }

          const res = await fetch(url, init);
          if (res.status === 429) {
            const body = await res.clone().json().catch(() => ({}));
            const retrySeconds = body?.error?.details?.[0]?.quotaErrorDetail?.retryDelaySeconds || body?.detail?.details?.[0]?.quotaErrorDetail?.retryDelaySeconds;
            
            if (siteId && adminClient) {
               console.warn(`[sync-campaigns] 429 Resource Exhausted. Locking site ${siteId}${retrySeconds ? ` for ${retrySeconds}s` : ""}.`);
               const lockUntil = new Date(Date.now() + (retrySeconds || 3600) * 1000).toISOString();
               await adminClient.from("sites").update({ 
                 next_sync_allowed_at: lockUntil,
                 sync_status: "error",
                 sync_error: `Quota exceeded. Retry allowed at ${new Date(lockUntil).toLocaleString()}`
               }).eq("id", siteId);
            }
            // CRITICAL: Do NOT retry 429 errors. Stop immediately to preserve quota.
            return res;
          }
          return res;
        } catch (e) {
          lastErr = e;
          if (i < attempts - 1) {
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
          }
        }
      }
      throw lastErr || new Error("Max retries exceeded");
    }

    // Função pra obter access_token
    const getAccessToken = async (refreshToken: string, apiSet: unknown = 1) => {

      const { clientId, clientSecret } = getCreds(apiSet);
      try {
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        });
        const j = await r.json();
        if (!r.ok) {
          debugLogs.push(`Token refresh failed for set ${apiSet}: ${JSON.stringify(j)}`);
          return null;
        }
        return j.access_token as string;
      } catch (e) {
        debugLogs.push(`Token refresh error for set ${apiSet}: ${e.message}`);
        return null;
      }
    };

    // Contas suspensas/canceladas não respondem à API (CUSTOMER_NOT_ENABLED).
    // Elas são puladas silenciosamente para não derrubar o sync do site inteiro.
    const INACTIVE = new Set(["suspended", "canceled", "cancelled", "closed", "inactive"]);
    const isInactiveErr = (msg: string) =>
      /CUSTOMER_NOT_ENABLED|NOT_ADS_USER|CUSTOMER_NOT_FOUND|ACCOUNT_SUSPENDED|suspended|cancell?ed|closed/i.test(msg);

    // Semáforo de Sincronização Concorrente
    if (bodySiteId) {
      const { data: currentSite } = await admin.from("sites").select("sync_lock, next_sync_allowed_at").eq("id", bodySiteId).maybeSingle();
      if (currentSite?.sync_lock) {
        return json({ error: "Sincronização já em andamento para este site." });
      }
      if (currentSite?.next_sync_allowed_at && new Date(currentSite.next_sync_allowed_at) > new Date()) {
        return json({ error: `Quota Google Ads excedida. Próxima tentativa permitida em ${new Date(currentSite.next_sync_allowed_at).toLocaleString()}` });
      }
      await admin.from("sites").update({ sync_lock: true, sync_status: "syncing", sync_started_at: new Date().toISOString() }).eq("id", bodySiteId);
    }

    try {
      // Para cada conta-raiz (MCC ou direta), expande sub-contas se for MCC
      for (const root of accounts) {

        const { devToken } = getCreds((root as any).api_set ?? 1);
        const accessToken = await getAccessToken(root.refresh_token!, (root as any).api_set ?? 1);
        if (!accessToken) {
          summary.push({ root_account: root.customer_id, error: "Falha na autenticação (refresh token inválido ou expirado)" });
          continue;
        }
        let leafAccounts: Array<{
          id: string; // db row id
          customer_id: string;
          login_customer_id: string | null;
          name: string;
          currency: string | null;
          is_mcc?: boolean;
        }> = [];

        if (root.is_mcc) {
          // Lista customer_clients NÃO-manager do MCC
          const cq = "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.status = 'ENABLED'";


          const cRes = await fetchWithRetry(
            `https://googleads.googleapis.com/v24/customers/${root.customer_id}/googleAds:search`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "developer-token": devToken,
                "login-customer-id": root.customer_id,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query: cq }),
            },
            3,
            admin,
            bodySiteId
          );

          const cJson = await cRes.json();
          debugLogs.push(`MCC ${root.customer_id} listChildren status=${cRes.status}`);
          if (!cRes.ok) {
            const msg = cJson?.error?.message ?? JSON.stringify(cJson);
            if (msg.includes("RESOURCE_EXHAUSTED")) {
              summary.push({ account: root.customer_id, error: "Cota de API excedida (Developer Token)" });
            } else {
              summary.push({ account: root.customer_id, error: `list children failed: ${msg}` });
            }
            continue;
          }
          const rows = (cJson.results ?? []) as Array<{
            customerClient: { id: string; descriptiveName?: string; currencyCode?: string; status?: string; manager?: boolean };
          }>;

          for (const r of rows) {
            const childCid = String(r.customerClient.id);
            const name = r.customerClient.descriptiveName ?? `Conta ${childCid}`;
            // Map Google Ads customer status → app status
            // ENABLED → connected; SUSPENDED → suspended; CANCELED/CLOSED → canceled
            const gStatus = String(r.customerClient.status ?? "ENABLED").toUpperCase();
            const appStatus =
              gStatus === "SUSPENDED" ? "suspended" :
              (gStatus === "CANCELED" || gStatus === "CLOSED") ? "canceled" :
              "connected";
            // upsert
            const { data: up } = await admin
              .from("google_accounts")
              .upsert(
                {
                  user_id: userId,
                  customer_id: childCid,
                  login_customer_id: root.customer_id,
                  manager_account_id: root.id,
                  account_name: name,
                  descriptive_name: name,
                  currency: r.customerClient.currencyCode ?? null,
                  is_mcc: r.customerClient.manager ?? false,
                  status: appStatus,
                  refresh_token: root.refresh_token,
                  api_set: root.api_set ?? 1,
                  last_synced_at: new Date().toISOString(),
                },
                { onConflict: "user_id,customer_id" },
              )
              .select("id")
              .single();
            if (up) {
              leafAccounts.push({
                id: up.id,
                customer_id: childCid,
                login_customer_id: root.customer_id,
                name,
                currency: r.customerClient.currencyCode ?? null,
                is_mcc: r.customerClient.manager ?? false,
              } as any);
            }
          }
        } else {
          // Conta direta (não MCC) — usa ela mesma
          leafAccounts = [{
            id: root.id,
            customer_id: root.customer_id,
            login_customer_id: root.login_customer_id ?? null,
            name: root.account_name ?? root.descriptive_name ?? root.customer_id,
            currency: root.currency ?? null,
            is_mcc: false,
          }];
        }

        // Para cada conta-folha, busca campanhas + métricas (período selecionado)
        const campaignQuery = `SELECT campaign.id, campaign.name, campaign.status, campaign.start_date_time, campaign.advertising_channel_type, campaign.final_url_suffix, campaign_budget.amount_micros, campaign.target_cpa.target_cpa_micros, campaign.bidding_strategy_type, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value, segments.date FROM campaign WHERE ${dateClause}`;

        let totalCampaigns = 0;
        let totalMetrics = 0;
        const accountResults: Array<Record<string, unknown>> = [];

        const rootSelected = accountIds.includes(root.id);
        // Filter leaves early to avoid unnecessary API calls (timeout prevention)
        if (accountIds.length > 0 && !rootSelected) {
          leafAccounts = leafAccounts.filter((l) => accountIds.includes(l.id));
        }
        for (const leaf of leafAccounts) {
          if ((leaf as any).is_mcc) continue; // Skip manager accounts for campaign sync
          try {
            const headers: Record<string, string> = {
              Authorization: `Bearer ${accessToken}`,
              "developer-token": devToken,
              "Content-Type": "application/json",
            };
            if (leaf.login_customer_id) {
              headers["login-customer-id"] = leaf.login_customer_id;
            }

            const camRes = await fetchWithRetry(
              `https://googleads.googleapis.com/v24/customers/${leaf.customer_id}/googleAds:search`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({ query: campaignQuery }),
              },
              3,
              admin,
              bodySiteId
            );

            const camJson = await camRes.json();
            debugLogs.push(`Account ${leaf.customer_id} campaigns status=${camRes.status} results=${camJson?.results?.length ?? 0}${camRes.ok ? "" : ` detail=${JSON.stringify(camJson?.error?.details ?? camJson?.error?.message ?? camJson).slice(0, 600)}`}`);

            if (!camRes.ok) {
              const msg = camJson?.error?.message ?? JSON.stringify(camJson);
              if (isInactiveErr(msg)) {
                // conta desativada no Google Ads → marca no banco e ignora (não é falha do site)
                await admin.from("google_accounts").update({ status: "suspended" }).eq("id", leaf.id);
                accountResults.push({ customer_id: leaf.customer_id, name: leaf.name, skipped: "suspended" });
              } else if (msg.includes("RESOURCE_EXHAUSTED")) {
                const errStr = "Cota de API excedida (Developer Token)";
                accountResults.push({ customer_id: leaf.customer_id, name: leaf.name, error: errStr });
                syncErrors.push({ account_id: leaf.customer_id, error: errStr });
              } else {
                accountResults.push({ customer_id: leaf.customer_id, name: leaf.name, error: msg });
                syncErrors.push({ account_id: leaf.customer_id, error: msg });
              }

              continue;
            }


            const results = (camJson.results ?? []) as Array<{
              campaign: {
                id: string; name: string; status: string; advertisingChannelType?: string;
                startDateTime?: string;
                finalUrlSuffix?: string;
                targetCpa?: { targetCpaMicros?: string };
                biddingStrategyType?: string;
              };
              campaignBudget?: { amountMicros?: string };
              metrics: { costMicros?: string; clicks?: string; impressions?: string; conversions?: number; conversionsValue?: number };
              segments: { date: string };
            }>;

            // Agrupa campanhas únicas (mantém último budget/cpa visto)
            const uniqueCampaigns = new Map<string, { name: string; status: string; channel: string; budget_micros: number | null; target_cpa_micros: number | null; bidding_strategy_type: string | null; final_url_suffix: string | null; start_date: string | null }>();
            for (const r of results) {
              const budgetMicros = r.campaignBudget?.amountMicros ? Number(r.campaignBudget.amountMicros) : null;
              // APENAS campanhas com estratégia TARGET_CPA e CPA definido em nível de campanha.
              // Ignora Maximize Conversions (mesmo se retornar targetCpaMicros calculado pelo Google).
              const strategy = r.campaign.biddingStrategyType ?? null;
              const cpaMicros = (strategy === "TARGET_CPA" && r.campaign.targetCpa?.targetCpaMicros)
                ? Number(r.campaign.targetCpa.targetCpaMicros)
                : null;
              uniqueCampaigns.set(r.campaign.id, {
                name: r.campaign.name,
                status: r.campaign.status,
                channel: r.campaign.advertisingChannelType ?? "DISPLAY",
                budget_micros: budgetMicros,
                target_cpa_micros: cpaMicros,
                bidding_strategy_type: strategy,
                final_url_suffix: r.campaign.finalUrlSuffix ?? null,
                start_date: (r.campaign.startDateTime ?? null)?.slice(0, 10) ?? null,
              });
            }

            // ===== AUTO-APLICAR UTM PADRÃO =====
            // Varre TODAS as campanhas da conta (inclusive novas / sem gasto no período)
            // e força o final_url_suffix padrão em qualquer uma que esteja diferente.
            const suffixByCampaign = new Map<string, string>();
            try {
              const allCampsRes = await fetch(
                `https://googleads.googleapis.com/v24/customers/${leaf.customer_id}/googleAds:search`,
                {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    query: "SELECT campaign.id, campaign.status, campaign.final_url_suffix FROM campaign WHERE campaign.status != 'REMOVED'",

                  }),
                },
              );
              const allCampsJson = await allCampsRes.json();
              const allRows = allCampsRes.ok ? ((allCampsJson.results ?? []) as Array<{ campaign: { id: string; status?: string; finalUrlSuffix?: string } }>) : [];
              if (!allCampsRes.ok) {
                debugLogs.push(`auto-utm list err ${leaf.customer_id}: ${allCampsJson?.error?.message ?? "?"}`);
              }

              const toFix: string[] = [];
              for (const r of allRows) {
                const cur = r.campaign.finalUrlSuffix ?? "";
                suffixByCampaign.set(r.campaign.id, cur);
                if (cur !== STANDARD_UTM_SUFFIX) toFix.push(r.campaign.id);
              }
              // fallback: se a listagem falhou, usa o que veio do relatório de métricas
              if (allRows.length === 0) {
                for (const [cid, info] of uniqueCampaigns) {
                  if (info.status === "REMOVED") continue;
                  suffixByCampaign.set(cid, info.final_url_suffix ?? "");
                  if ((info.final_url_suffix ?? "") !== STANDARD_UTM_SUFFIX) toFix.push(cid);
                }
              }

              if (toFix.length > 0) {
                const CHUNK_MUT = 100;
                let fixedOk = 0;
                let fixedFail = 0;
                for (let i = 0; i < toFix.length; i += CHUNK_MUT) {
                  const slice = toFix.slice(i, i + CHUNK_MUT);
                  const mutateBody = {
                    operations: slice.map((cid) => ({
                      update: {
                        resourceName: `customers/${leaf.customer_id}/campaigns/${cid}`,
                        finalUrlSuffix: STANDARD_UTM_SUFFIX,
                      },
                      updateMask: "final_url_suffix",
                    })),
                    partialFailure: true,
                  };
                  const mr = await fetch(
                    `https://googleads.googleapis.com/v24/customers/${leaf.customer_id}/campaigns:mutate`,
                    { method: "POST", headers, body: JSON.stringify(mutateBody) },
                  );
                  const mj = await mr.json();
                  if (!mr.ok) {
                    fixedFail += slice.length;
                    debugLogs.push(`auto-utm mutate err ${leaf.customer_id}: ${mj?.error?.message ?? "?"}`);
                  } else {
                    const failed = new Set<number>();
                    if (mj.partialFailureError?.details) {
                      for (const d of mj.partialFailureError.details) {
                        for (const e of (d.errors ?? [])) {
                          const idx = e?.location?.fieldPathElements?.[0]?.index;
                          if (typeof idx === "number") failed.add(idx);
                        }
                      }
                    }
                    fixedOk += (mj.results?.length ?? slice.length) - failed.size;
                    fixedFail += failed.size;
                    // marca como padrão as que deram certo
                    slice.forEach((cid, idx) => { if (!failed.has(idx)) suffixByCampaign.set(cid, STANDARD_UTM_SUFFIX); });
                  }
                }
                debugLogs.push(`auto-utm ${leaf.customer_id}: ok=${fixedOk} fail=${fixedFail} (de ${toFix.length})`);
              }
            } catch (e) {
              debugLogs.push(`auto-utm exception ${leaf.customer_id}: ${String(e)}`);
            }


            // NOTE: Fallback de Target CPA por ad_group foi REMOVIDO propositalmente.
            // Só exibimos CPA quando a campanha usa estratégia TARGET_CPA definida
            // no nível de campanha (CPA desejado). Em Maximizar Conversões, nada.









            // Bulk upsert campanhas
            if (uniqueCampaigns.size > 0) {
              const campaignRows = Array.from(uniqueCampaigns, ([cid, info]) => {
                const suffix = suffixByCampaign.get(cid) ?? info.final_url_suffix ?? null;
                return {
                  user_id: userId,
                  google_account_id: leaf.id,
                  campaign_id: cid,
                  name: info.name,
                  status: info.status.toLowerCase(),
                  channel_type: info.channel,
                  budget_micros: info.budget_micros,
                  target_cpa_micros: info.target_cpa_micros,
                  bidding_strategy_type: info.bidding_strategy_type,
                  start_date: info.start_date,
                  final_url_suffix: suffix,
                  utm_applied_at: suffix === STANDARD_UTM_SUFFIX ? new Date().toISOString() : null,
                };
              });

              const { error: campErr } = await admin
                .from("campaigns")
                .upsert(campaignRows, { onConflict: "user_id,google_account_id,campaign_id" });
              if (!campErr) totalCampaigns += campaignRows.length;
              else debugLogs.push(`campaigns upsert err ${leaf.customer_id}: ${campErr.message}`);
            }

            // ===== SYNC FINAL URLS (ad_group_ad.final_urls) =====
            // Garante que toda campanha (inclusive novas) tenha seu link visível na UI.
            try {
              const adsQuery = "SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.status FROM ad_group_ad WHERE campaign.status != 'REMOVED'";

              const adsRes = await fetch(
                `https://googleads.googleapis.com/v24/customers/${leaf.customer_id}/googleAds:search`,
                { method: "POST", headers, body: JSON.stringify({ query: adsQuery }) },
              );
              const adsJson = await adsRes.json();
              if (adsRes.ok) {
                const adRows = (adsJson.results ?? []) as Array<{
                  campaign: { id: string };
                  adGroup: { id: string };
                  adGroupAd: { ad: { id: string; finalUrls?: string[] }; status?: string };
                }>;
                const urlPayload: Array<Record<string, unknown>> = [];
                for (const r of adRows) {
                  const urls = r.adGroupAd?.ad?.finalUrls ?? [];
                  if (!urls.length) continue;
                  urlPayload.push({
                    user_id: userId,
                    google_account_id: leaf.id,
                    campaign_id: r.campaign.id,
                    ad_group_id: r.adGroup?.id ?? null,
                    ad_id: r.adGroupAd?.ad?.id ?? "",
                    final_url: urls[0],
                    source: "ad.final_urls",
                    ad_status: (r.adGroupAd?.status ?? "").toUpperCase() || null,
                  });
                }
                const CHUNK_URL = 500;
                for (let i = 0; i < urlPayload.length; i += CHUNK_URL) {
                  const slice = urlPayload.slice(i, i + CHUNK_URL);
                  const { error: urlErr } = await admin
                    .from("campaign_final_urls")
                    .upsert(slice, { onConflict: "user_id,google_account_id,campaign_id,ad_id" });
                  if (urlErr) debugLogs.push(`final_urls upsert err ${leaf.customer_id}: ${urlErr.message}`);
                }
                debugLogs.push(`final_urls ${leaf.customer_id}: ${urlPayload.length} ads`);
              } else {
                debugLogs.push(`final_urls fetch err ${leaf.customer_id}: ${adsJson?.error?.message ?? "?"}`);
              }
            } catch (e) {
              debugLogs.push(`final_urls exception ${leaf.customer_id}: ${String(e)}`);
            }

            // Bulk upsert métricas diárias (apenas campos de spend; preserva revenue existente)
            const metricRows = results.map((r) => {
              const spend = Number(r.metrics.costMicros ?? 0) / 1_000_000;
              return {
                user_id: userId,
                google_account_id: leaf.id,
                campaign_id: r.campaign.id,
                date: r.segments.date,
                spend,
                clicks: Number(r.metrics.clicks ?? 0),
                impressions: Number(r.metrics.impressions ?? 0),
                conversions: Number(r.metrics.conversions ?? 0),
              };
            });

            // chunk to avoid huge payloads
            const CHUNK = 500;
            for (let i = 0; i < metricRows.length; i += CHUNK) {
              const slice = metricRows.slice(i, i + CHUNK);
              const { error: mErr } = await admin
                .from("daily_metrics")
                .upsert(slice, { onConflict: "user_id,google_account_id,campaign_id,date" });
              if (!mErr) totalMetrics += slice.length;
              else debugLogs.push(`metrics upsert err ${leaf.customer_id}: ${mErr.message}`);
            }

            accountResults.push({
              customer_id: leaf.customer_id,
              name: leaf.name,
              campaigns: uniqueCampaigns.size,
              metric_rows: results.length,
            });
          } catch (e) {
            const msg = String(e);
            accountResults.push(
              isInactiveErr(msg)
                ? { customer_id: leaf.customer_id, name: leaf.name, skipped: "suspended" }
                : { customer_id: leaf.customer_id, name: leaf.name, error: msg },
            );
          }
        }

        summary.push({
          root_account: root.customer_id,
          is_mcc: root.is_mcc,
          leaf_count: leafAccounts.length,
          total_campaigns_synced: totalCampaigns,
          total_metric_rows: totalMetrics,
          accounts: accountResults,
        });
      } catch (e) {
        const msg = String(e);
        summary.push(
          isInactiveErr(msg)
            ? { root_account: root.customer_id, skipped: "suspended" }
            : { root_account: root.customer_id, error: msg },
        );
      }
    }
  } catch (e) {
    throw e;
  }


















    if (bodySiteId) {
      const hasErrors = syncErrors.length > 0;
      await admin.from("sync_state").upsert({
        site_id: bodySiteId,
        source: "google-ads-sync-campaigns",
        last_status: hasErrors ? "partial_failure" : "success",
        last_finished_at: new Date().toISOString(),
        last_error: hasErrors ? `Failed accounts: ${syncErrors.map(e => e.account_id).join(", ")}` : null,
        failed_accounts: syncErrors.map(e => e.account_id),
      }, { onConflict: "site_id,source" });

      await admin.from("sites").update({ 
        sync_lock: false,
        last_full_sync_at: hasErrors ? undefined : new Date().toISOString(),
        sync_status: hasErrors ? "error" : "completed",
        sync_error: hasErrors ? `Sincronização incompleta. ${syncErrors.length} contas falharam.` : null
      }).eq("id", bodySiteId);
    }

    return json({ ok: true, summary, debug: debugLogs, errors: syncErrors });

  } catch (e) {
    if (bodySiteId) {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await admin.from("sites").update({ sync_lock: false, sync_status: "error", sync_error: String(e) }).eq("id", bodySiteId);
    }
    console.error("[sync-campaigns] uncaught", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});


function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
