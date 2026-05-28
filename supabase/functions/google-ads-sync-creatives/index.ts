// Sincroniza métricas por criativo (ad_group_ad) das campanhas ENABLED do usuário.
// Receita atribuída proporcional ao custo: revenue_ad = revenue_total_camp_dia * (cost_ad / cost_total_dia)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

type CampaignRow = { campaign_id: string | number | null; name: string | null; google_account_id: string | null };
type AccountRow = { id: string; customer_id: string | null; refresh_token: string | null; login_customer_id: string | null };

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
      const allowed = new Set((siteCampaigns ?? [])
        .map((r: { campaign_id: string | null }) => String(r.campaign_id ?? ""))
        .filter((id) => id && id !== "__aggregate__"));
      camps = camps.filter((c) => allowed.has(String(c.campaign_id)));
    }

    const byAccount = new Map<string, { ids: string[] }>();
    const campMeta = new Map<string, { name: string; google_account_id: string }>();
    for (const c of camps) {
      if (!c.google_account_id) continue;
      campMeta.set(String(c.campaign_id), { name: c.name ?? "", google_account_id: c.google_account_id });
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

    type Row = {
      campaign_id: string; ad_group_id: string; ad_group_name: string;
      ad_id: string; ad_name: string; ad_type: string; ad_status: string;
      date: string; cost: number; clicks: number; impressions: number; conversions: number;
    };
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

      const allowedIds = new Set(ids.map((id) => String(id).replace(/\D/g, "")).filter(Boolean));
      // Para contas grandes (>200 camps) faz UMA query account-wide e filtra localmente
      // — evita milhares de chunks IN(...) que estouravam o timeout e abortavam a sync.
      const useAccountWide = allowedIds.size > 200;
      const chunks: string[][] = useAccountWide ? [[]] : chunkArr([...allowedIds], 50);

      for (const chunk of chunks) {
        const idList = chunk.join(",");
        const query = `
          SELECT campaign.id, ad_group.id, ad_group.name,
                 ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status,
                 ad_group_ad.ad.responsive_display_ad.headlines,
                 ad_group_ad.ad.responsive_display_ad.long_headline,
                 ad_group_ad.ad.image_ad.name,
                 segments.date,
                 metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
          FROM ad_group_ad
          WHERE segments.date BETWEEN '${from}' AND '${to}'
            ${idList ? `AND campaign.id IN (${idList})` : ""}
            AND ad_group_ad.status != 'REMOVED'
            AND metrics.impressions > 0
        `;
        let pageToken: string | undefined;
        try {
          do {
            const r = await fetch(
              `https://googleads.googleapis.com/v21/customers/${acc.customer_id}/googleAds:search`,
              { method: "POST", headers, body: JSON.stringify({ query, pageToken }) },
            );
            const j = await r.json();
            if (!r.ok) {
              console.error("[sync-creatives] gaql error", acc.customer_id, JSON.stringify(j).slice(0, 500));
              break; // não aborta a função inteira; segue para próximo chunk/conta
            }
            for (const row of j.results ?? []) {
              const campId = String(row.campaign?.id ?? "");
              if (useAccountWide && !allowedIds.has(campId)) continue;
              const ad = row.adGroupAd?.ad ?? {};
              const headlines = ad.responsiveDisplayAd?.headlines as Array<{ text?: string }> | undefined;
              const longHeadline = ad.responsiveDisplayAd?.longHeadline?.text as string | undefined;
              const imageName = ad.imageAd?.name as string | undefined;
              const headlineText = headlines?.map((h) => h.text).filter(Boolean).slice(0, 3).join(" | ");
              const adName = ad.name || headlineText || longHeadline || imageName || `Ad ${ad.id}`;
              all.push({
                campaign_id: campId,
                ad_group_id: String(row.adGroup?.id ?? ""),
                ad_group_name: String(row.adGroup?.name ?? ""),
                ad_id: String(ad.id ?? ""),
                ad_name: String(adName ?? ""),
                ad_type: String(ad.type ?? ""),
                ad_status: String(row.adGroupAd?.status ?? ""),
                date: String(row.segments?.date ?? ""),
                cost: Number(row.metrics?.costMicros ?? 0) / 1_000_000,
                clicks: Number(row.metrics?.clicks ?? 0),
                impressions: Number(row.metrics?.impressions ?? 0),
                conversions: Number(row.metrics?.conversions ?? 0),
              });
            }
            pageToken = j.nextPageToken || undefined;
          } while (pageToken);
        } catch (e) {
          console.error("[sync-creatives] fetch failed", acc.customer_id, String(e));
        }
      }
    }

    // Receita por (campaign_id, date) do daily_metrics
    const campIds = [...campMeta.keys()];
    const revByCampDate = new Map<string, number>();
    for (const chunk of chunkArr(campIds, 200)) {
      const { data } = await admin
        .from("daily_metrics")
        .select("campaign_id, date, revenue")
        .eq("user_id", userId)
        .in("campaign_id", chunk)
        .gte("date", from)
        .lte("date", to)
        .limit(50000);
      for (const r of data ?? []) {
        const k = `${r.campaign_id}|${r.date}`;
        revByCampDate.set(k, (revByCampDate.get(k) ?? 0) + Number(r.revenue ?? 0));
      }
    }

    // Total de custo por (campaign,date) pelas linhas de criativo (denominador)
    const adCostByCampDate = new Map<string, number>();
    for (const r of all) {
      const k = `${r.campaign_id}|${r.date}`;
      adCostByCampDate.set(k, (adCostByCampDate.get(k) ?? 0) + r.cost);
    }

    const dedup = new Map<string, any>();
    for (const r of all) {
      if (!r.ad_id || !r.campaign_id) continue;
      const k = `${r.campaign_id}|${r.date}`;
      const totalCost = adCostByCampDate.get(k) || 1;
      const revTotal = revByCampDate.get(k) ?? 0;
      const revShare = totalCost > 0 ? (r.cost / totalCost) * revTotal : 0;
      const meta = campMeta.get(r.campaign_id);
      const dk = `${r.campaign_id}|${r.ad_group_id}|${r.ad_id}|${r.date}`;
      const ex = dedup.get(dk);
      if (ex) {
        ex.cost += r.cost;
        ex.clicks += r.clicks;
        ex.impressions += r.impressions;
        ex.conversions += r.conversions;
        ex.revenue_usd += revShare;
      } else {
        dedup.set(dk, {
          user_id: userId,
          google_account_id: meta?.google_account_id ?? null,
          campaign_id: r.campaign_id,
          campaign_name: meta?.name ?? null,
          ad_group_id: r.ad_group_id,
          ad_group_name: r.ad_group_name,
          ad_id: r.ad_id,
          ad_name: r.ad_name,
          ad_type: r.ad_type,
          ad_status: r.ad_status,
          date: r.date,
          cost: r.cost,
          clicks: r.clicks,
          impressions: r.impressions,
          conversions: r.conversions,
          revenue_usd: revShare,
        });
      }
    }

    const inserts = [...dedup.values()];
    if (inserts.length) {
      // UPSERT em vez de DELETE+INSERT: evita perder dias se a fetch da API
      // falhar parcialmente (preserva histórico já sincronizado).
      for (const chunk of chunkArr(inserts, 1000)) {
        const { error } = await admin
          .from("creative_metrics")
          .upsert(chunk, { onConflict: "user_id,campaign_id,ad_group_id,ad_id,date" });
        if (error) return json({ error: error.message });
      }
    }

    return json({ ok: true, period: { from, to }, rows: inserts.length, campaigns: campMeta.size });
  } catch (e) {
    console.error("[google-ads-sync-creatives]", e);
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

function chunkArr<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function json(p: unknown) {
  return new Response(JSON.stringify(p), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
