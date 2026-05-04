// Cron diário: roda o avaliador inteligente (placements-evaluate) por SITE,
// usando site_placement_config (espelho de site_automation_config). Cada par
// site/conta tem seu próprio toggle, intervalo e dry-run, garantindo isolamento.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SR);

  const { data: configs, error } = await admin
    .from("site_placement_config")
    .select("id, user_id, site_id, google_account_id, automation_enabled, automation_dry_run, interval_days, last_run_at")
    .eq("automation_enabled", true);
  if (error) return json({ error: error.message });

  const now = Date.now();
  const results: any[] = [];
  for (const c of configs ?? []) {
    const intervalDays = Math.max(1, Number(c.interval_days ?? 15));
    const last = c.last_run_at ? new Date(c.last_run_at).getTime() : 0;
    const dueIn = (now - last) / 86400_000;
    if (last && dueIn < intervalDays) {
      results.push({ user_id: c.user_id, site_id: c.site_id, skipped: true, days_since_last: +dueIn.toFixed(2), interval_days: intervalDays });
      continue;
    }
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/placements-evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SR}` },
        body: JSON.stringify({
          mode: c.automation_dry_run ? "preview" : "apply",
          user_id: c.user_id,
          site_id: c.site_id,
          google_account_id: c.google_account_id,
          lookback_days: intervalDays,
        }),
      });
      const j = await r.json();
      results.push({ user_id: c.user_id, site_id: c.site_id, ok: r.ok, dry_run: c.automation_dry_run, summary: j?.summary, newly_blocked: j?.newly_blocked, interval_days: intervalDays });
      await admin.from("site_placement_config")
        .update({ last_run_at: new Date().toISOString() })
        .eq("id", c.id);
    } catch (e) {
      results.push({ user_id: c.user_id, site_id: c.site_id, error: String(e) });
    }
  }
  return json({ ok: true, processed: results.length, results });
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
