// Cron: roda a expansão por país vencedor por usuário (respeita intervalo).
// Para cada winner, cria a campanha duplicada PAUSED.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SR);

  const { data: configs, error } = await admin
    .from("rules_config")
    .select("user_id, geo_expansion_enabled, geo_expansion_min_roi_pct, geo_expansion_min_campaign_cost_brl, geo_expansion_min_country_cost_brl, geo_expansion_min_countries, geo_expansion_lookback_days, geo_expansion_interval_days, geo_expansion_budget_multiplier, geo_expansion_last_run_at")
    .eq("geo_expansion_enabled", true);
  if (error) return json({ error: error.message });

  const now = Date.now();
  const results: any[] = [];

  for (const c of configs ?? []) {
    const intervalDays = Math.max(1, Number(c.geo_expansion_interval_days ?? 7));
    const last = c.geo_expansion_last_run_at ? new Date(c.geo_expansion_last_run_at).getTime() : 0;
    const dueIn = (now - last) / 86400_000;
    if (last && dueIn < intervalDays) {
      results.push({ user_id: c.user_id, skipped: true, days_since_last: +dueIn.toFixed(2) });
      continue;
    }

    const { data: sites } = await admin
      .from("sites").select("id").eq("user_id", c.user_id);
    const siteIds = (sites ?? []).map((s: any) => s.id);
    if (siteIds.length === 0) {
      results.push({ user_id: c.user_id, skipped: true, reason: "sem sites" });
      continue;
    }

    for (const site_id of siteIds) {
      try {
        // 1) preview winners
        const previewRes = await fetch(`${SUPABASE_URL}/functions/v1/geo-expansion`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SR}` },
          body: JSON.stringify({
            mode: "preview", user_id: c.user_id, site_id,
            min_roi_pct: c.geo_expansion_min_roi_pct,
            min_campaign_cost_brl: c.geo_expansion_min_campaign_cost_brl,
            min_country_cost_brl: c.geo_expansion_min_country_cost_brl,
            min_countries: c.geo_expansion_min_countries,
            lookback_days: c.geo_expansion_lookback_days,
          }),
        });
        const previewJson = await previewRes.json();
        const items: any[] = previewJson?.items ?? [];
        let created = 0; let failed = 0;
        for (const it of items) {
          if (!it.country_criterion_id) continue;
          const r = await fetch(`${SUPABASE_URL}/functions/v1/geo-expansion`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${SR}` },
            body: JSON.stringify({
              mode: "apply", user_id: c.user_id, site_id,
              budget_multiplier: c.geo_expansion_budget_multiplier,
              item: {
                campaign_id: it.campaign_id,
                google_account_id: it.google_account_id,
                country_code: it.country_code,
                country_name: it.country_name,
                country_criterion_id: it.country_criterion_id,
                roi_pct: it.roi_pct, cost_brl: it.cost_brl, revenue_brl: it.revenue_brl,
              },
            }),
          });
          const j = await r.json();
          if (j?.ok) created++; else failed++;
        }
        results.push({ user_id: c.user_id, site_id, winners: items.length, created, failed });
      } catch (e) {
        results.push({ user_id: c.user_id, site_id, error: String(e) });
      }
    }

    await admin.from("rules_config")
      .update({ geo_expansion_last_run_at: new Date().toISOString() })
      .eq("user_id", c.user_id);
  }

  return json({ ok: true, processed: results.length, results });
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
