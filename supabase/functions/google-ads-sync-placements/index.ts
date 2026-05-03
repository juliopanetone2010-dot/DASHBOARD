// Sincroniza placements detalhados (Display/YouTube) para uma campanha do Google Ads.
// Usa GAQL: detail_placement_view
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const ALLOWED_PRESETS = new Set(["TODAY","YESTERDAY","LAST_7_DAYS","LAST_14_DAYS","LAST_30_DAYS"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const campaignId = String((body as any)?.campaign_id ?? "").trim();
    if (!campaignId) return json({ error: "campaign_id obrigatório" });
    const datePreset = String((body as any)?.date_preset ?? "LAST_7_DAYS").toUpperCase();
    const dateFrom = (body as any)?.from as string | null;
    const dateTo = (body as any)?.to as string | null;

    let dateClause = "segments.date DURING LAST_7_DAYS";
    if (ALLOWED_PRESETS.has(datePreset)) dateClause = `segments.date DURING ${datePreset}`;
    if (dateFrom && dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      dateClause = `segments.date BETWEEN '${dateFrom}' AND '${dateTo}'`;
    }

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Localiza a conta Ads que tem essa campanha
    const { data: camp, error: campErr } = await admin
      .from("campaigns")
      .select("google_account_id, name")
      .eq("user_id", userId)
      .eq("campaign_id", campaignId)
      .limit(1)
      .maybeSingle();
    if (campErr || !camp?.google_account_id) {
      return json({ error: "Campanha não encontrada ou sem conta vinculada" });
    }

    const { data: account, error: accErr } = await admin
      .from("google_accounts")
      .select("id, customer_id, login_customer_id, refresh_token")
      .eq("id", camp.google_account_id)
      .maybeSingle();
    if (accErr || !account?.refresh_token) {
      return json({ error: "Conta Ads sem refresh_token" });
    }

    const accessToken = await getAccessToken(account.refresh_token);

    const query = `
      SELECT
        detail_placement_view.placement,
        detail_placement_view.display_name,
        detail_placement_view.target_url,
        detail_placement_view.placement_type,
        detail_placement_view.group_placement_target_url,
        ad_group.id,
        ad_group.name,
        campaign.id,
        campaign.name,
        metrics.clicks,
        metrics.impressions,
        metrics.cost_micros,
        metrics.conversions,
        metrics.ctr,
        metrics.average_cpc,
        segments.date
      FROM detail_placement_view
      WHERE ${dateClause}
        AND campaign.id = ${campaignId}
    `;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
      "Content-Type": "application/json",
    };
    if (account.login_customer_id) headers["login-customer-id"] = account.login_customer_id;

    const results: any[] = [];
    let pageToken: string | undefined;
    let page = 0;
    do {
      const res = await fetch(
        `https://googleads.googleapis.com/v21/customers/${account.customer_id}/googleAds:search`,
        { method: "POST", headers, body: JSON.stringify({ query, pageToken }) },
      );
      const data = await res.json();
      if (!res.ok) {
        console.error("[sync-placements] GAQL error", JSON.stringify(data));
        const detail = data?.error?.details?.[0]?.errors?.[0] ?? data?.error;
        return json({ error: data?.error?.message ?? "GAQL error", detail, query });
      }
      results.push(...((data.results ?? []) as any[]));
      pageToken = data.nextPageToken || undefined;
      page += 1;
    } while (pageToken);
    console.log("[sync-placements] results", results.length, "pages", page, "campaign", campaignId);

    // Limpa o range para essa campanha antes de re-inserir (snapshot)
    let delQ = admin.from("ads_placements").delete()
      .eq("user_id", userId)
      .eq("campaign_id", campaignId);
    if (dateFrom && dateTo) {
      delQ = delQ.gte("date", dateFrom).lte("date", dateTo);
    }
    await delQ;

    const rows = results.map((r) => {
      const cost = Number(r.metrics?.costMicros ?? 0) / 1_000_000;
      const placement = String(r.detailPlacementView?.placement ?? r.detailPlacementView?.displayName ?? "unknown");
      const targetUrl = r.detailPlacementView?.targetUrl ?? r.detailPlacementView?.groupPlacementTargetUrl ?? null;
      const placementClean = cleanPlacement(placement, targetUrl);
      return {
        user_id: userId,
        google_account_id: account.id,
        campaign_id: String(r.campaign?.id ?? campaignId),
        campaign_name: r.campaign?.name ?? camp.name,
        ad_group_id: r.adGroup?.id ? String(r.adGroup.id) : null,
        ad_group_name: r.adGroup?.name ?? null,
        placement,
        placement_clean: placementClean,
        display_name: r.detailPlacementView?.displayName ?? null,
        target_url: targetUrl,
        placement_type: r.detailPlacementView?.placementType ?? null,
        date: r.segments?.date,
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        cost,
        conversions: Number(r.metrics?.conversions ?? 0),
        ctr: Number(r.metrics?.ctr ?? 0),
        avg_cpc: Number(r.metrics?.averageCpc ?? 0) / 1_000_000,
      };
    });

    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await admin.from("ads_placements")
        .upsert(rows.slice(i, i + CHUNK), { onConflict: "user_id,google_account_id,campaign_id,ad_group_id,placement,date" });
    }

    return json({ ok: true, inserted: rows.length, campaign_id: campaignId, pages: page });
  } catch (e) {
    console.error("[sync-placements] uncaught", e);
    return json({ error: String(e) });
  }
});

async function getAccessToken(refreshToken: string) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
  return j.access_token as string;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Normaliza placement do Ads para domínio:
// "https://afrisearch.com/page" → "afrisearch.com"
// "mobileapp::1-com.foo.bar"   → "com.foo.bar"
// "youtube.com/channel/UCxx"   → "youtube.com"
function cleanPlacement(placement: string, targetUrl: string | null): string {
  const candidate = (placement || targetUrl || "").trim();
  if (!candidate) return "";
  // App Android/iOS
  const appMatch = candidate.match(/mobileapp::\d+-(.+)$/i);
  if (appMatch) return appMatch[1].toLowerCase();
  // URL completa
  try {
    const u = new URL(candidate.startsWith("http") ? candidate : `https://${candidate}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return candidate.replace(/^www\./, "").toLowerCase();
  }
}
