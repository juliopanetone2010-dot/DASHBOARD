// Sincroniza:
// 1) Sub-contas (customer_client) de cada MCC
// 2) Campanhas + métricas (YESTERDAY) de cada conta não-manager
// Moeda padrão do sistema = USD. Convertemos spend (BRL/etc) para USD usando cotação em tempo real.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

async function getUsdBrlRate(): Promise<number> {
  try {
    const res = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL");
    const data = await res.json();
    const rate = Number(data?.USDBRL?.bid);
    if (Number.isFinite(rate) && rate > 0) return rate;
  } catch (_) { /* */ }
  return 5.5;
}

function toUsd(amount: number, currency: string | null | undefined, usdBrl: number): number {
  const cur = (currency ?? "USD").toUpperCase();
  if (cur === "USD") return amount;
  if (cur === "BRL") return usdBrl > 0 ? amount / usdBrl : amount;
  return amount;
}

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
    try {
      const body = await req.json().catch(() => ({}));
      if (body && typeof body === "object") {
        datePreset = (body as any).date_preset ?? null;
        dateFrom = (body as any).from ?? null;
        dateTo = (body as any).to ?? null;
      }
    } catch (_) { /* no body */ }

    const ALLOWED_PRESETS = new Set(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS"]);
    let dateClause = "segments.date DURING LAST_7_DAYS";
    if (datePreset && ALLOWED_PRESETS.has(String(datePreset).toUpperCase())) {
      dateClause = `segments.date DURING ${String(datePreset).toUpperCase()}`;
    } else if (dateFrom && dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      dateClause = `segments.date BETWEEN '${dateFrom}' AND '${dateTo}'`;
    }

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;

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

    // Busca todas as contas conectadas (MCCs e contas diretas)
    const { data: accounts, error: accErr } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, is_mcc, account_name, descriptive_name, currency, login_customer_id")
      .eq("user_id", userId)
      .not("refresh_token", "is", null);

    if (accErr) return json({ error: accErr.message });
    if (!accounts || accounts.length === 0) {
      return json({ error: "Nenhuma conta Google Ads conectada. Conecte primeiro." });
    }

    const summary: Array<Record<string, unknown>> = [];
    const debugLogs: string[] = [];

    // Função pra obter access_token
    const getAccessToken = async (refreshToken: string) => {
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
      if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
      return j.access_token as string;
    };

    // Cotação USD↔BRL para conversão de spend para USD (moeda padrão do sistema)
    const usdBrlRate = await getUsdBrlRate();
    debugLogs.push(`fx USD/BRL=${usdBrlRate}`);

    // Para cada conta-raiz (MCC ou direta), expande sub-contas se for MCC
    for (const root of accounts) {
      try {
        const accessToken = await getAccessToken(root.refresh_token!);
        let leafAccounts: Array<{
          id: string; // db row id
          customer_id: string;
          login_customer_id: string | null;
          name: string;
          currency: string | null;
        }> = [];

        if (root.is_mcc) {
          // Lista customer_clients NÃO-manager do MCC
          const cq = `
            SELECT customer_client.id, customer_client.descriptive_name,
                   customer_client.currency_code, customer_client.manager,
                   customer_client.status, customer_client.level
            FROM customer_client
            WHERE customer_client.status = 'ENABLED'
              AND customer_client.manager = FALSE
          `;
          const cRes = await fetch(
            `https://googleads.googleapis.com/v21/customers/${root.customer_id}/googleAds:search`,
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
          );
          const cJson = await cRes.json();
          debugLogs.push(`MCC ${root.customer_id} listChildren status=${cRes.status}`);
          if (!cRes.ok) {
            summary.push({ account: root.customer_id, error: `list children failed: ${JSON.stringify(cJson)}` });
            continue;
          }
          const rows = (cJson.results ?? []) as Array<{
            customerClient: { id: string; descriptiveName?: string; currencyCode?: string };
          }>;

          for (const r of rows) {
            const childCid = String(r.customerClient.id);
            const name = r.customerClient.descriptiveName ?? `Conta ${childCid}`;
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
                  is_mcc: false,
                  status: "connected",
                  refresh_token: root.refresh_token,
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
              });
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
          }];
        }

        // Para cada conta-folha, busca campanhas + métricas (período selecionado)
        const campaignQuery = `
          SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            metrics.cost_micros,
            metrics.clicks,
            metrics.impressions,
            metrics.conversions,
            metrics.conversions_value,
            segments.date
          FROM campaign
          WHERE ${dateClause}
        `;

        let totalCampaigns = 0;
        let totalMetrics = 0;
        const accountResults: Array<Record<string, unknown>> = [];

        for (const leaf of leafAccounts) {
          try {
            const headers: Record<string, string> = {
              Authorization: `Bearer ${accessToken}`,
              "developer-token": devToken,
              "Content-Type": "application/json",
            };
            if (leaf.login_customer_id) {
              headers["login-customer-id"] = leaf.login_customer_id;
            }

            const camRes = await fetch(
              `https://googleads.googleapis.com/v21/customers/${leaf.customer_id}/googleAds:search`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({ query: campaignQuery }),
              },
            );
            const camJson = await camRes.json();
            debugLogs.push(`Account ${leaf.customer_id} campaigns status=${camRes.status} results=${camJson?.results?.length ?? 0}`);

            if (!camRes.ok) {
              accountResults.push({
                customer_id: leaf.customer_id,
                name: leaf.name,
                error: camJson?.error?.message ?? JSON.stringify(camJson),
              });
              continue;
            }

            const results = (camJson.results ?? []) as Array<{
              campaign: { id: string; name: string; status: string; advertisingChannelType?: string };
              metrics: { costMicros?: string; clicks?: string; impressions?: string; conversions?: number; conversionsValue?: number };
              segments: { date: string };
            }>;

            // Agrupa campanhas únicas
            const uniqueCampaigns = new Map<string, { name: string; status: string; channel: string }>();
            for (const r of results) {
              uniqueCampaigns.set(r.campaign.id, {
                name: r.campaign.name,
                status: r.campaign.status,
                channel: r.campaign.advertisingChannelType ?? "DISPLAY",
              });
            }

            // Upsert campanhas
            for (const [cid, info] of uniqueCampaigns) {
              const { error: campErr } = await admin
                .from("campaigns")
                .upsert(
                  {
                    user_id: userId,
                    google_account_id: leaf.id,
                    campaign_id: cid,
                    name: info.name,
                    status: info.status.toLowerCase(),
                    channel_type: info.channel,
                  },
                  { onConflict: "user_id,campaign_id" },
                );
              if (!campErr) totalCampaigns++;
            }

            // Upsert métricas diárias
            for (const r of results) {
              // Spend mantido na moeda nativa da conta (Ads geralmente BRL nesta conta)
              const spend = Number(r.metrics.costMicros ?? 0) / 1_000_000;
              const revenue = Number(r.metrics.conversionsValue ?? 0);
              const clicks = Number(r.metrics.clicks ?? 0);
              const impressions = Number(r.metrics.impressions ?? 0);
              const conversions = Number(r.metrics.conversions ?? 0);
              const profit = revenue - spend;
              const roi = spend > 0 ? ((revenue - spend) / spend) * 100 : 0;
              const roas = spend > 0 ? revenue / spend : 0;
              const ecpm = impressions > 0 ? (spend / impressions) * 1000 : 0;

              const { error: mErr } = await admin
                .from("daily_metrics")
                .upsert(
                  {
                    user_id: userId,
                    google_account_id: leaf.id,
                    campaign_id: r.campaign.id,
                    date: r.segments.date,
                    spend, revenue, profit, roi, roas,
                    clicks, impressions, conversions, ecpm,
                  },
                  { onConflict: "user_id,campaign_id,date" },
                );
              if (!mErr) totalMetrics++;
            }

            accountResults.push({
              customer_id: leaf.customer_id,
              name: leaf.name,
              campaigns: uniqueCampaigns.size,
              metric_rows: results.length,
            });
          } catch (e) {
            accountResults.push({
              customer_id: leaf.customer_id,
              name: leaf.name,
              error: String(e),
            });
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
        summary.push({ root_account: root.customer_id, error: String(e) });
      }
    }

    return json({ ok: true, summary, debug: debugLogs });
  } catch (e) {
    console.error("[sync-campaigns] uncaught", e);
    return json({ error: String(e) });
  }
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
