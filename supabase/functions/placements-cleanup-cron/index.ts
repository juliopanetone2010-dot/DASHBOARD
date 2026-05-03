// Cron diário: roda o avaliador inteligente (placements-evaluate) em modo apply
// para cada usuário com placement_auto_cleanup_enabled. O evaluator só bloqueia
// placements que atingem o critério forte (fase 4 do funil).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SR);

  const { data: users, error } = await admin
    .from("rules_config")
    .select("user_id, placement_cleanup_interval_days, placement_cleanup_last_run_at")
    .eq("placement_auto_cleanup_enabled", true);
  if (error) return json({ error: error.message });

  const now = Date.now();
  const results: any[] = [];
  for (const u of users ?? []) {
    const intervalDays = Math.max(1, Number(u.placement_cleanup_interval_days ?? 15));
    const last = u.placement_cleanup_last_run_at ? new Date(u.placement_cleanup_last_run_at).getTime() : 0;
    const dueIn = (now - last) / 86400_000;
    if (last && dueIn < intervalDays) {
      results.push({ user_id: u.user_id, skipped: true, days_since_last: +dueIn.toFixed(2), interval_days: intervalDays });
      continue;
    }
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/placements-evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SR}` },
        body: JSON.stringify({ mode: "apply", user_id: u.user_id, lookback_days: intervalDays }),
      });
      const j = await r.json();
      results.push({ user_id: u.user_id, ok: r.ok, summary: j?.summary, newly_blocked: j?.newly_blocked, interval_days: intervalDays });
      await admin.from("rules_config")
        .update({ placement_cleanup_last_run_at: new Date().toISOString() })
        .eq("user_id", u.user_id);
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
