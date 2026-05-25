// Sincroniza URLs finais REAIS dos anúncios direto da API do Google Ads.
// Hierarquia: ad.final_urls → campaign.tracking_url_template/final_url_suffix.
// Persiste em public.campaign_final_urls. NÃO infere, NÃO usa GAM.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({} as any));
    const accountIds: string[] = Array.isArray(body?.account_ids) ? body.account_ids : [];
    const requestedUserId: string | null = typeof body?.user_id === "string" ? body.user_id : null;

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const token = authHeader.replace("Bearer ", "");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    let userId: string | undefined;
    if (token && serviceRoleKey && token === serviceRoleKey) {
      userId = requestedUserId ?? undefined;
    } else {
      const { data: claims } = await userClient.auth.getClaims(token);
      userId = claims?.claims?.sub;
    }
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let accountsQ = admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, is_mcc, login_customer_id")
      .eq("user_id", userId)
      .eq("is_mcc", false)
      .not("refresh_token", "is", null);
    if (accountIds.length > 0) accountsQ = accountsQ.in("id", accountIds);
    const { data: accounts, error: accErr } = await accountsQ;
    if (accErr) return json({ error: accErr.message });
    if (!accounts || accounts.length === 0) return json({ ok: true, upserted: 0, accounts: 0 });

    const getAccessToken = async (rt: string) => {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret,
          refresh_token: rt, grant_type: "refresh_token",
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
      return j.access_token as string;
    };

    let totalUpserted = 0;
    const accountSummaries: any[] = [];

    for (const acc of accounts) {
      try {
        const accessToken = await getAccessToken(acc.refresh_token!);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devToken,
          "Content-Type": "application/json",
        };
        if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;

        const query = `
          SELECT
            campaign.id,
            campaign.final_url_suffix, campaign.tracking_url_template,
            ad_group.id,
            ad_group_ad.ad.id, ad_group_ad.status,
            ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls,
            ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.final_url_suffix
          FROM ad_group_ad
          WHERE ad_group_ad.status != REMOVED
            AND campaign.status != REMOVED
        `;

        const res = await fetch(
          `https://googleads.googleapis.com/v21/customers/${acc.customer_id}/googleAds:search`,
          { method: "POST", headers, body: JSON.stringify({ query, pageSize: 10000 }) },
        );
        const j = await res.json();
        if (!res.ok) {
          const detail = Array.isArray(j?.error?.details) ? JSON.stringify(j.error.details) : "";
          accountSummaries.push({ customer_id: acc.customer_id, error: j?.error?.message ?? JSON.stringify(j), detail });
          continue;
        }

        const results = (j.results ?? []) as any[];
        const rows = results.map((r) => {
          const adFinalUrls: string[] = r.adGroupAd?.ad?.finalUrls ?? [];
          const adMobileUrls: string[] = r.adGroupAd?.ad?.finalMobileUrls ?? [];
          const adTracking: string | null = r.adGroupAd?.ad?.trackingUrlTemplate ?? null;
          const adSuffix: string | null = r.adGroupAd?.ad?.finalUrlSuffix ?? null;
          const campTracking: string | null = r.campaign?.trackingUrlTemplate ?? null;
          const campSuffix: string | null = r.campaign?.finalUrlSuffix ?? null;

          let finalUrl: string | null = null;
          let source = "unknown";
          if (adFinalUrls.length > 0) {
            finalUrl = adFinalUrls[0];
            source = "ad.final_urls";
          }

          return {
            user_id: userId,
            google_account_id: acc.id,
            campaign_id: String(r.campaign?.id ?? ""),
            ad_group_id: String(r.adGroup?.id ?? "") || null,
            ad_id: String(r.adGroupAd?.ad?.id ?? "") || null,
            final_url: finalUrl,
            mobile_url: adMobileUrls[0] ?? null,
            tracking_template: adTracking ?? campTracking,
            final_url_suffix: adSuffix ?? campSuffix,
            source,
            ad_status: r.adGroupAd?.status ?? null,
          };
        }).filter((r) => r.campaign_id);

        // Bulk upsert em chunks
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const slice = rows.slice(i, i + CHUNK);
          const { error: upErr } = await admin
            .from("campaign_final_urls")
            .upsert(slice, { onConflict: "user_id,google_account_id,campaign_id,ad_id", ignoreDuplicates: false });
          if (upErr) {
            accountSummaries.push({ customer_id: acc.customer_id, upsert_error: upErr.message });
            break;
          }
          totalUpserted += slice.length;
        }
        accountSummaries.push({ customer_id: acc.customer_id, ads: rows.length });
      } catch (e) {
        accountSummaries.push({ customer_id: acc.customer_id, error: String(e) });
      }
    }

    return json({ ok: true, upserted: totalUpserted, accounts: accountSummaries });
  } catch (e) {
    console.error("[sync-final-urls] uncaught", e);
    return json({ error: String(e) });
  }
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
