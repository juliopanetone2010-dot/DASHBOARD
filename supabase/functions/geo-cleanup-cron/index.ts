// Cron diário: roda a limpeza de países por usuário, respeitando intervalo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SR);

  const { data: configs, error } = await admin
    .from("rules_config")
    .select("user_id, geo_auto_cleanup_enabled, geo_cleanup_max_roi_pct, geo_cleanup_min_cost_brl, geo_cleanup_min_countries, geo_cleanup_min_campaign_cost_brl, geo_cleanup_interval_days, geo_cleanup_lookback_days, geo_cleanup_last_run_at")
    .eq("geo_auto_cleanup_enabled", true);
  if (error) return json({ error: error.message });

  const now = Date.now();
  const results: any[] = [];

  for (const c of configs ?? []) {
    const intervalDays = Math.max(1, Number(c.geo_cleanup_interval_days ?? 15));
    const last = c.geo_cleanup_last_run_at ? new Date(c.geo_cleanup_last_run_at).getTime() : 0;
    const dueIn = (now - last) / 86400_000;
    if (last && dueIn < intervalDays) {
      results.push({ user_id: c.user_id, skipped: true, days_since_last: +dueIn.toFixed(2), interval_days: intervalDays });
      continue;
    }

    // Pega sites do usuário e roda 1 chamada por site (para isolamento)
    const { data: sites } = await admin
      .from("sites").select("id").eq("user_id", c.user_id);
    const siteIds = (sites ?? []).map((s: any) => s.id);
    if (siteIds.length === 0) {
      results.push({ user_id: c.user_id, skipped: true, reason: "sem sites" });
      continue;
    }

    for (const site_id of siteIds) {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/geo-cleanup`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SR}` },
          body: JSON.stringify({
            mode: "apply",
            user_id: c.user_id,
            site_id,
            max_roi_pct: c.geo_cleanup_max_roi_pct,
            min_cost_brl: c.geo_cleanup_min_cost_brl,
            min_countries: c.geo_cleanup_min_countries,
            min_campaign_cost_brl: c.geo_cleanup_min_campaign_cost_brl,
            lookback_days: c.geo_cleanup_lookback_days,
          }),
        });
        const j = await r.json();
        results.push({ user_id: c.user_id, site_id, ok: r.ok, applied: j?.applied, failed: j?.failed });
      } catch (e) {
        results.push({ user_id: c.user_id, site_id, error: String(e) });
      }
    }

    await admin.from("rules_config")
      .update({ geo_cleanup_last_run_at: new Date().toISOString() })
      .eq("user_id", c.user_id);
  }

  return json({ ok: true, processed: results.length, results });
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
