// Lista campanhas dos últimos N dias da conta/site origem com métricas agregadas
// para o painel de migração. Permite filtrar por google_account_id e/ou site_id.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const googleAccountId = url.searchParams.get("google_account_id") || null;
    const siteId = url.searchParams.get("site_id") || null;
    const days = Math.min(parseInt(url.searchParams.get("days") || "15"), 60);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "unauthorized" }, 401);
    const userId = u.user.id;

    const admin = createClient(supabaseUrl, serviceKey);
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

    // Campanhas (filtro opcional)
    let cQ = admin
      .from("campaigns")
      .select("campaign_id, name, channel_type, google_account_id, status")
      .eq("user_id", userId)
      .eq("channel_type", "DISPLAY");
    if (googleAccountId) cQ = cQ.eq("google_account_id", googleAccountId);
    const { data: camps, error: cErr } = await cQ;
    if (cErr) return json({ error: cErr.message }, 500);

    const campIds = (camps ?? []).map((c) => c.campaign_id);
    if (campIds.length === 0) return json({ items: [] });

    // Métricas agregadas
    const { data: mets } = await admin
      .from("daily_metrics")
      .select("campaign_id, spend, revenue, profit, conversions, date")
      .eq("user_id", userId)
      .gte("date", since)
      .in("campaign_id", campIds);

    const agg = new Map<string, { spend: number; revenue: number; profit: number; conv: number; days: Set<string>; daily: number[] }>();
    for (const m of mets ?? []) {
      const k = String(m.campaign_id);
      const a = agg.get(k) ?? { spend: 0, revenue: 0, profit: 0, conv: 0, days: new Set<string>(), daily: [] };
      a.spend += Number(m.spend) || 0;
      a.revenue += Number(m.revenue) || 0;
      a.profit += Number(m.profit) || 0;
      a.conv += Number(m.conversions) || 0;
      a.days.add(String(m.date));
      const dailyRoi = (Number(m.spend) || 0) > 0 ? ((Number(m.profit) || 0) / Number(m.spend)) * 100 : 0;
      a.daily.push(dailyRoi);
      agg.set(k, a);
    }

    // Top países
    const { data: countries } = await admin
      .from("campaign_country_metrics")
      .select("campaign_id, country_code, country_name, cost, revenue_usd")
      .eq("user_id", userId)
      .gte("date", since)
      .in("campaign_id", campIds);
    const byCampCountry = new Map<string, Array<{ code: string; name: string; cost: number }>>();
    for (const c of countries ?? []) {
      const k = String(c.campaign_id);
      const arr = byCampCountry.get(k) ?? [];
      const existing = arr.find((x) => x.code === c.country_code);
      if (existing) existing.cost += Number(c.cost) || 0;
      else arr.push({ code: String(c.country_code), name: String(c.country_name || c.country_code), cost: Number(c.cost) || 0 });
      byCampCountry.set(k, arr);
    }

    // Já migradas (ignora completamente, só mostra como flag)
    const { data: migrated } = await admin
      .from("campaign_migrations")
      .select("source_campaign_id, status")
      .eq("user_id", userId)
      .in("source_campaign_id", campIds);
    const migratedSet = new Set(
      (migrated ?? []).filter((m) => m.status === "success").map((m) => String(m.source_campaign_id)),
    );

    const items = (camps ?? []).map((c) => {
      const a = agg.get(String(c.campaign_id));
      const spend = a?.spend ?? 0;
      const revenue = a?.revenue ?? 0;
      const profit = a?.profit ?? 0;
      const roi = spend > 0 ? (profit / spend) * 100 : 0;
      // estabilidade = 100 - desvio padrão dos ROIs diários (clampado)
      const daily = a?.daily ?? [];
      const mean = daily.length ? daily.reduce((s, v) => s + v, 0) / daily.length : 0;
      const variance = daily.length
        ? daily.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / daily.length
        : 0;
      const std = Math.sqrt(variance);
      const stability = Math.max(0, 100 - std);

      const top = (byCampCountry.get(String(c.campaign_id)) ?? [])
        .sort((x, y) => y.cost - x.cost)
        .slice(0, 3);

      return {
        campaign_id: c.campaign_id,
        name: c.name,
        channel_type: c.channel_type,
        google_account_id: c.google_account_id,
        google_ads_status: c.status,
        spend,
        revenue,
        profit,
        roi_pct: roi,
        conversions: a?.conv ?? 0,
        days_active: a?.days.size ?? 0,
        stability_score: stability,
        top_countries: top,
        already_migrated: migratedSet.has(String(c.campaign_id)),
      };
    });

    return json({ items, days });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
