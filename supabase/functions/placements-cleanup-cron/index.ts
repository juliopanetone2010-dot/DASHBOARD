// Cron diário: chama placements-cleanup em modo "notify" para cada usuário
// que ativou placement_auto_cleanup_enabled.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SR);

  const { data: users, error } = await admin
    .from("rules_config")
    .select("user_id, placement_cleanup_min_days, placement_cleanup_max_roi_pct, placement_cleanup_min_cost_brl, placement_cleanup_min_clicks")
    .eq("placement_auto_cleanup_enabled", true);
  if (error) return json({ error: error.message });

  const results: any[] = [];
  for (const u of users ?? []) {
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/placements-cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SR}` },
        body: JSON.stringify({
          mode: "apply",
          user_id: u.user_id,
          min_days: u.placement_cleanup_min_days,
          max_roi_pct: u.placement_cleanup_max_roi_pct,
          min_cost_brl: u.placement_cleanup_min_cost_brl,
          min_clicks: u.placement_cleanup_min_clicks,
        }),
      });
      const j = await r.json();
      results.push({ user_id: u.user_id, ok: r.ok, bad: j?.stats?.bad ?? 0 });
    } catch (e) {
      results.push({ user_id: u.user_id, error: String(e) });
    }
  }
  return json({ ok: true, processed: results.length, results });
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
