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

  let bodySiteId: string | null = null;
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

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE);
    let userId: string | undefined;
    if (isServiceRole) {
      if (bodyUserId) userId = bodyUserId;
      else if (bodySiteId) {
        const { data: s } = await admin.from("sites").select("user_id").eq("id", bodySiteId).maybeSingle();
        userId = s?.user_id ?? undefined;
      } else if (accountIds.length > 0) {
        const { data: ga } = await admin.from("google_accounts").select("user_id").eq("id", accountIds[0]).maybeSingle();
        userId = ga?.user_id ?? undefined;
      }
    } else {
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: { user } } = await userClient.auth.getUser(token);
      userId = user?.id;
    }
    if (!userId) return json({ error: "Token inválido" });

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
          if (siteId && adminClient) {
             const { data: site } = await adminClient.from("sites").select("next_sync_allowed_at").eq("id", siteId).maybeSingle();
             if (site?.next_sync_allowed_at && new Date(site.next_sync_allowed_at) > new Date()) {
                const waitMs = new Date(site.next_sync_allowed_at).getTime() - Date.now();
                return new Response(JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED", details: [{ quotaErrorDetail: { retryDelaySeconds: Math.round(waitMs/1000) } }] } }), { status: 429 });
             }
          }

          const res = await fetch(url, init);
          if (res.status === 429) {
            const body = await res.clone().json().catch(() => ({}));
            const retrySeconds = body?.error?.details?.[0]?.quotaErrorDetail?.retryDelaySeconds || body?.detail?.details?.[0]?.quotaErrorDetail?.retryDelaySeconds;
            if (siteId && adminClient) {
               const lockUntil = new Date(Date.now() + (retrySeconds || 3600) * 1000).toISOString();
               await adminClient.from("sites").update({ next_sync_allowed_at: lockUntil, sync_status: "error", sync_error: "Quota exceeded" }).eq("id", siteId);
            }
            return res;
          }
          return res;
        } catch (e) {
          lastErr = e;
          if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
      throw lastErr || new Error("Max retries exceeded");
    }

    const getAccessToken = async (refreshToken: string, apiSet: unknown = 1) => {
      const { clientId, clientSecret } = getCreds(apiSet);
      try {
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
        });
        const j = await r.json();
        return r.ok ? j.access_token as string : null;
      } catch { return null; }
    };

    const isInactiveErr = (msg: string) => /CUSTOMER_NOT_ENABLED|NOT_ADS_USER|CUSTOMER_NOT_FOUND|ACCOUNT_SUSPENDED|suspended|cancell?ed|closed/i.test(msg);

    if (bodySiteId) {
      const { data: currentSite } = await admin.from("sites").select("sync_lock, next_sync_allowed_at").eq("id", bodySiteId).maybeSingle();
      if (currentSite?.sync_lock) return json({ error: "Sincronização já em andamento." });
      if (currentSite?.next_sync_allowed_at && new Date(currentSite.next_sync_allowed_at) > new Date()) return json({ error: "Quota excedida" });
      await admin.from("sites").update({ sync_lock: true, sync_status: "syncing", sync_started_at: new Date().toISOString() }).eq("id", bodySiteId);
    }

    try {
      for (const root of accounts) {
        const { devToken } = getCreds((root as any).api_set ?? 1);
        const accessToken = await getAccessToken(root.refresh_token!, (root as any).api_set ?? 1);
        if (!accessToken) {
          summary.push({ root_account: root.customer_id, error: "Auth failed" });
          continue;
        }

        let leafAccounts: any[] = [];
        if (root.is_mcc) {
          const cq = "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED'";
          const cRes = await fetchWithRetry(`https://googleads.googleapis.com/v18/customers/${root.customer_id}/googleAds:search`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "developer-token": devToken, "login-customer-id": root.customer_id, "Content-Type": "application/json" },
            body: JSON.stringify({ query: cq }),
          }, 3, admin, bodySiteId);

          const cJson = await cRes.json();
          if (cRes.ok) {
            for (const r of cJson.results ?? []) {
              const childCid = String(r.customerClient.id);
              const { data: up } = await admin.from("google_accounts").upsert({
                user_id: userId, customer_id: childCid, login_customer_id: root.customer_id, manager_account_id: root.id,
                account_name: r.customerClient.descriptiveName ?? childCid, descriptive_name: r.customerClient.descriptiveName ?? childCid,
                currency: r.customerClient.currencyCode ?? null, is_mcc: r.customerClient.manager ?? false,
                status: "connected", refresh_token: root.refresh_token, api_set: root.api_set ?? 1, last_synced_at: new Date().toISOString(),
              }, { onConflict: "user_id,customer_id" }).select("id").single();
              if (up) leafAccounts.push({ id: up.id, customer_id: childCid, login_customer_id: root.customer_id, is_mcc: r.customerClient.manager });
            }
          }
        } else {
          leafAccounts = [{ id: root.id, customer_id: root.customer_id, login_customer_id: root.login_customer_id, is_mcc: false }];
        }

        const campaignQuery = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.final_url_suffix, campaign_budget.amount_micros, campaign.target_cpa.target_cpa_micros, campaign.bidding_strategy_type, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value, segments.date FROM campaign WHERE ${dateClause}`;
        let totalCampaigns = 0, totalMetrics = 0;
        const accountResults: any[] = [];

        for (const leaf of leafAccounts) {
          if (leaf.is_mcc) continue;
          if (accountIds.length > 0 && !accountIds.includes(leaf.id)) continue;

          try {
            const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, "developer-token": devToken, "Content-Type": "application/json" };
            if (leaf.login_customer_id) headers["login-customer-id"] = leaf.login_customer_id;

            const camRes = await fetchWithRetry(`https://googleads.googleapis.com/v18/customers/${leaf.customer_id}/googleAds:search`, {
              method: "POST", headers, body: JSON.stringify({ query: campaignQuery }),
            }, 3, admin, bodySiteId);

            const camJson = await camRes.json();
            if (!camRes.ok) {
              const msg = camJson?.error?.message ?? "Error";
              if (isInactiveErr(msg)) await admin.from("google_accounts").update({ status: "suspended" }).eq("id", leaf.id);
              else syncErrors.push({ account_id: leaf.customer_id, error: msg });
              continue;
            }

            const results = camJson.results ?? [];
            const uniqueCampaigns = new Map();
            for (const r of results) {
              const strategy = r.campaign.biddingStrategyType;
              const cpaMicros = (strategy === "TARGET_CPA" && r.campaign.targetCpa?.targetCpaMicros) ? Number(r.campaign.targetCpa.targetCpaMicros) : null;
              uniqueCampaigns.set(r.campaign.id, {
                name: r.campaign.name, status: r.campaign.status, channel: r.campaign.advertisingChannelType ?? "DISPLAY",
                budget_micros: r.campaignBudget?.amountMicros ? Number(r.campaignBudget.amountMicros) : null,
                target_cpa_micros: cpaMicros, bidding_strategy_type: strategy, final_url_suffix: r.campaign.finalUrlSuffix ?? null,
                start_date: r.campaign.startDateTime?.slice(0, 10) ?? null,
              });
            }

            if (uniqueCampaigns.size > 0) {
              const campaignRows = Array.from(uniqueCampaigns, ([cid, info]) => ({
                user_id: userId, google_account_id: leaf.id, campaign_id: cid, name: info.name, status: info.status.toLowerCase(),
                channel_type: info.channel, budget_micros: info.budget_micros, target_cpa_micros: info.target_cpa_micros,
                bidding_strategy_type: info.bidding_strategy_type, start_date: info.start_date, final_url_suffix: info.final_url_suffix,
              }));
              await admin.from("campaigns").upsert(campaignRows, { onConflict: "user_id,google_account_id,campaign_id" });
              totalCampaigns += campaignRows.length;
            }

            const metricRows = results.map((r: any) => ({
              user_id: userId, google_account_id: leaf.id, campaign_id: r.campaign.id, date: r.segments.date,
              spend: Number(r.metrics.costMicros ?? 0) / 1000000, clicks: Number(r.metrics.clicks ?? 0),
              impressions: Number(r.metrics.impressions ?? 0), conversions: Number(r.metrics.conversions ?? 0),
            }));
            for (let i = 0; i < metricRows.length; i += 500) {
              await admin.from("daily_metrics").upsert(metricRows.slice(i, i + 500), { onConflict: "user_id,google_account_id,campaign_id,date" });
            }
            totalMetrics += metricRows.length;
            accountResults.push({ customer_id: leaf.customer_id, campaigns: uniqueCampaigns.size, metrics: metricRows.length });

          } catch (e) {
            accountResults.push({ customer_id: leaf.customer_id, error: String(e) });
          }
        }
        summary.push({ root: root.customer_id, total_campaigns: totalCampaigns, total_metrics: totalMetrics, details: accountResults });
      }
    } finally {
      if (bodySiteId) {
        const hasErrors = syncErrors.length > 0;
        await admin.from("sites").update({ sync_lock: false, sync_status: hasErrors ? "error" : "completed", sync_error: hasErrors ? "Sync failed for some accounts" : null }).eq("id", bodySiteId);
      }
    }

    return json({ ok: true, summary, errors: syncErrors });

  } catch (e) {
    if (bodySiteId) {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await admin.from("sites").update({ sync_lock: false, sync_status: "error", sync_error: String(e) }).eq("id", bodySiteId);
    }
    return new Response(JSON.stringify({ error: String(e) }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
