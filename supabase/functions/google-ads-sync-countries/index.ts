// Sincroniza métricas por país (segments.country_criterion_id) das campanhas ENABLED do usuário.
// Receita é atribuída proporcional ao custo: revenue_usd_pais = revenue_usd_total_campanha * (cost_pais / cost_total)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { COUNTRY_BY_ID } from "./countries.ts";

type CampaignRow = { campaign_id: string | number | null; name: string | null; google_account_id: string | null };
type AccountRow = { id: string; customer_id: string | null; refresh_token: string | null; login_customer_id: string | null };
type CountryMetricInsert = {
  user_id: string; google_account_id: string | null; campaign_id: string; date: string;
  country_code: string; country_name: string; country_criterion_id: string;
  cost: number; clicks: number; impressions: number; conversions: number; revenue_usd: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const lookbackDays = Math.max(1, Math.min(90, Number(body?.lookback_days ?? 30)));
    const siteId = typeof body?.site_id === "string" && body.site_id !== "all" ? body.site_id : null;

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const today = new Date();
    const toDate = new Date(today.getTime() - 86400_000);
    const fromDate = new Date(today.getTime() - lookbackDays * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const from = iso(fromDate), to = iso(toDate);

    const { data: campsRaw } = await admin
      .from("campaigns")
      .select("campaign_id, name, google_account_id")
      .eq("user_id", userId)
      .eq("status", "enabled");
    let camps = (campsRaw ?? []) as CampaignRow[];
    if (siteId) {
      const { data: siteCampaigns } = await admin
        .from("gam_placement_revenue")
        .select("campaign_id")
        .eq("user_id", userId)
        .eq("site_id", siteId)
        .gte("date", from)
        .lte("date", to)
        .limit(50000);
      const allowedCampaigns = new Set((siteCampaigns ?? [])
        .map((r: { campaign_id: string | null }) => String(r.campaign_id ?? ""))
        .filter((id) => id && id !== "__aggregate__"));
      camps = camps.filter((c) => allowedCampaigns.has(String(c.campaign_id)));
    }

    const byAccount = new Map<string, { ids: string[]; }>();
    const campMeta = new Map<string, { name: string; google_account_id: string }>();
    for (const c of camps ?? []) {
      if (!c.google_account_id) continue;
      campMeta.set(String(c.campaign_id), { name: c.name, google_account_id: c.google_account_id });
      const e = byAccount.get(c.google_account_id) ?? { ids: [] };
      e.ids.push(String(c.campaign_id));
      byAccount.set(c.google_account_id, e);
    }
    if (campMeta.size === 0) return json({ ok: true, processed: 0, msg: "sem campanhas" });

    const { data: accs } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id")
      .eq("user_id", userId)
      .in("id", [...byAccount.keys()]);
    const accMap = new Map<string, AccountRow>();
    for (const a of (accs ?? []) as AccountRow[]) accMap.set(a.id, a);

    type Row = { campaign_id: string; date: string; country_id: string; cost: number; clicks: number; impressions: number; conversions: number };
    const all: Row[] = [];

    const tokenCache = new Map<string, string>();
    for (const [accountId, { ids }] of byAccount) {
      const acc = accMap.get(accountId);
      if (!acc?.refresh_token || !acc?.customer_id) continue;
      const token = await getToken(acc.refresh_token, tokenCache);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
        "Content-Type": "application/json",
      };
      if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;

      for (const chunk of chunkArr(ids, 50)) {
        const idList = chunk.map((id) => id.replace(/\D/g, "")).filter(Boolean).join(",");
        if (!idList) continue;
        const query = `
          SELECT campaign.id, segments.date,
                 geographic_view.country_criterion_id,
                 metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
          FROM geographic_view
          WHERE segments.date BETWEEN '${from}' AND '${to}'
            AND campaign.id IN (${idList})
            AND metrics.cost_micros > 0
        `;
        let pageToken: string | undefined;
        do {
          const r = await fetch(
            `https://googleads.googleapis.com/v21/customers/${acc.customer_id}/googleAds:search`,
            { method: "POST", headers, body: JSON.stringify({ query, pageToken }) },
          );
          const j = await r.json();
          if (!r.ok) {
            console.error("[sync-countries] gaql error", JSON.stringify(j));
            return json({ error: j?.error?.message ?? "Erro Google Ads" });
          }
          for (const row of j.results ?? []) {
            const countryId = String(
              row.geographicView?.countryCriterionId ??
              (row.geographicView?.resourceName?.split("~").pop() ?? "")
            );
            all.push({
              campaign_id: String(row.campaign?.id ?? ""),
              date: String(row.segments?.date ?? ""),
              country_id: countryId,
              cost: Number(row.metrics?.costMicros ?? 0) / 1_000_000,
              clicks: Number(row.metrics?.clicks ?? 0),
              impressions: Number(row.metrics?.impressions ?? 0),
              conversions: Number(row.metrics?.conversions ?? 0),
            });
          }
          pageToken = j.nextPageToken || undefined;
        } while (pageToken);
      }
    }

    // Receita por (campaign_id, date) vinda do daily_metrics
    const campIds = [...campMeta.keys()];
    const revByCampDate = new Map<string, number>();
    const costByCampDate = new Map<string, number>();
    for (const chunk of chunkArr(campIds, 200)) {
      const { data } = await admin
        .from("daily_metrics")
        .select("campaign_id, date, spend, revenue")
        .eq("user_id", userId)
        .in("campaign_id", chunk)
        .gte("date", from)
        .lte("date", to)
        .limit(50000);
      for (const r of data ?? []) {
        const k = `${r.campaign_id}|${r.date}`;
        revByCampDate.set(k, (revByCampDate.get(k) ?? 0) + Number(r.revenue ?? 0));
        costByCampDate.set(k, (costByCampDate.get(k) ?? 0) + Number(r.spend ?? 0));
      }
    }

    // Agrega custo por (campaign,date) a partir das linhas geo (para denominador da proporção)
    const geoCostByCampDate = new Map<string, number>();
    for (const r of all) {
      const k = `${r.campaign_id}|${r.date}`;
      geoCostByCampDate.set(k, (geoCostByCampDate.get(k) ?? 0) + r.cost);
    }

    // Resolve países desconhecidos via Google Ads API (geo_target_constant)
    const unknownIds = new Set<string>();
    for (const r of all) {
      if (r.country_id && !COUNTRY_BY_ID[r.country_id]) unknownIds.add(r.country_id);
    }
    const resolved = new Map<string, { code: string; name: string }>();
    if (unknownIds.size > 0) {
      await resolveGeoTargets([...unknownIds], [...accMap.values()], tokenCache, resolved);
    }

    // Monta upsert (deduplicado por campaign+date+country_code)
    const dedup = new Map<string, any>();
    for (const r of all) {
      const k = `${r.campaign_id}|${r.date}`;
      const totalCost = geoCostByCampDate.get(k) || 1;
      const revenueTotal = revByCampDate.get(k) ?? 0;
      const revenueShare = totalCost > 0 ? (r.cost / totalCost) * revenueTotal : 0;
      const country =
        COUNTRY_BY_ID[r.country_id] ??
        resolved.get(r.country_id) ??
        { code: "ZZ", name: `ID ${r.country_id || "?"}` };
      const meta = campMeta.get(r.campaign_id);
      const dk = `${r.campaign_id}|${r.date}|${country.code}`;
      const existing = dedup.get(dk);
      if (existing) {
        existing.cost += r.cost;
        existing.clicks += r.clicks;
        existing.impressions += r.impressions;
        existing.conversions += r.conversions;
        existing.revenue_usd += revenueShare;
      } else {
        dedup.set(dk, {
          user_id: userId,
          google_account_id: meta?.google_account_id ?? null,
          campaign_id: r.campaign_id,
          date: r.date,
          country_code: country.code,
          country_name: country.name,
          country_criterion_id: r.country_id,
          cost: r.cost,
          clicks: r.clicks,
          impressions: r.impressions,
          conversions: r.conversions,
          revenue_usd: revenueShare,
        });
      }
    }
    const inserts = [...dedup.values()];

    // Limpa janela e re-insere
    if (inserts.length) {
      let deleteQuery = admin.from("campaign_country_metrics")
        .delete()
        .eq("user_id", userId)
        .gte("date", from)
        .lte("date", to);
      if (siteId) deleteQuery = deleteQuery.in("campaign_id", [...campMeta.keys()]);
      await deleteQuery;
      for (const chunk of chunkArr(inserts, 1000)) {
        const { error } = await admin.from("campaign_country_metrics").insert(chunk);
        if (error) return json({ error: error.message });
      }
    }

    return json({ ok: true, period: { from, to }, rows: inserts.length, campaigns: campMeta.size });
  } catch (e) {
    console.error("[google-ads-sync-countries]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});

async function getToken(refreshToken: string, cache: Map<string, string>) {
  if (cache.has(refreshToken)) return cache.get(refreshToken)!;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
  cache.set(refreshToken, j.access_token);
  return j.access_token as string;
}

async function resolveGeoTargets(
  ids: string[],
  accounts: any[],
  tokenCache: Map<string, string>,
  resolved: Map<string, { code: string; name: string }>,
) {
  const cleanIds = [...new Set(ids.map((id) => id.replace(/\D/g, "")).filter(Boolean))];
  if (cleanIds.length === 0) return;
  const q = `
    SELECT geo_target_constant.id, geo_target_constant.name,
           geo_target_constant.country_code, geo_target_constant.target_type
    FROM geo_target_constant
    WHERE geo_target_constant.resource_name IN (${cleanIds.map((id) => `'geoTargetConstants/${id}'`).join(",")})
  `;
  for (const acc of accounts) {
    if (!acc?.refresh_token || !acc?.customer_id) continue;
    try {
      const token = await getToken(acc.refresh_token, tokenCache);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
        "Content-Type": "application/json",
      };
      if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;
      const rr = await fetch(
        `https://googleads.googleapis.com/v21/customers/${acc.customer_id}/googleAds:search`,
        { method: "POST", headers, body: JSON.stringify({ query: q }) },
      );
      const jj = await rr.json();
      if (!rr.ok) {
        console.error("[sync-countries] geo_target_constant resolve error", JSON.stringify(jj));
        continue;
      }
      for (const row of jj.results ?? []) {
        const gid = String(row.geoTargetConstant?.id ?? "");
        const name = String(row.geoTargetConstant?.name ?? "");
        const code = String(row.geoTargetConstant?.countryCode ?? "ZZ");
        if (gid && name) resolved.set(gid, { code, name });
      }
      if (cleanIds.every((id) => resolved.has(id))) return;
    } catch (e) {
      console.error("[sync-countries] geo resolve threw", e);
    }
  }
}

function chunkArr<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function json(p: unknown) {
  return new Response(JSON.stringify(p), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
