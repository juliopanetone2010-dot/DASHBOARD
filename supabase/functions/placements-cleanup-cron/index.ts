// Cron diário: roda o avaliador inteligente (placements-evaluate) por SITE,
// usando site_placement_config (espelho de site_automation_config). Cada par
// site/conta tem seu próprio toggle, intervalo e dry-run, garantindo isolamento.
//
// PROTEÇÃO DE FRESCOR: só roda se os dados do site estão atualizados:
//   - sites.last_full_sync_at < 36h atrás
//   - sites.sync_status != "failed" / "processing"
//   - há gam_placement_revenue de ontem (D-1) para o site
//   - há ads_placements de ontem (D-1) para alguma conta vinculada
// Se qualquer check falhar, pula o site (sem atualizar last_run_at) — ele tenta
// de novo no próximo cron, depois que o sync recuperar.
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
  const yesterday = new Date(now - 86400_000).toISOString().slice(0, 10);
  const STALE_HOURS = 36;
  const results: any[] = [];

  for (const c of configs ?? []) {
    const intervalDays = Math.max(1, Number(c.interval_days ?? 15));
    const last = c.last_run_at ? new Date(c.last_run_at).getTime() : 0;
    const dueIn = (now - last) / 86400_000;
    if (last && dueIn < intervalDays) {
      results.push({ user_id: c.user_id, site_id: c.site_id, skipped: "interval", days_since_last: +dueIn.toFixed(2), interval_days: intervalDays });
      continue;
    }

    // ---- Proteção: dados do site precisam estar frescos ----
    const freshness = await checkFreshness(admin, c.user_id, c.site_id, c.google_account_id, yesterday, STALE_HOURS);
    if (!freshness.ok) {
      results.push({ user_id: c.user_id, site_id: c.site_id, skipped: "stale_data", reason: freshness.reason });
      // NÃO atualiza last_run_at — quando o sync ficar fresco, próximo cron roda.
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

async function checkFreshness(
  admin: ReturnType<typeof createClient>,
  userId: string,
  siteId: string,
  googleAccountId: string,
  yesterday: string,
  staleHours: number,
): Promise<{ ok: boolean; reason?: string }> {
  // 1. status do site
  const { data: site } = await admin
    .from("sites")
    .select("sync_status, last_full_sync_at")
    .eq("id", siteId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!site) return { ok: false, reason: "site_not_found" };
  if (site.sync_status === "failed") return { ok: false, reason: "sync_failed" };
  if (site.sync_status === "processing") return { ok: false, reason: "sync_processing" };
  if (!site.last_full_sync_at) return { ok: false, reason: "never_synced" };
  const ageH = (Date.now() - new Date(site.last_full_sync_at as string).getTime()) / 3600_000;
  if (ageH > staleHours) return { ok: false, reason: `last_sync_${ageH.toFixed(1)}h_ago` };

  // 2. receita GAM de ontem para o site (precisa ter pelo menos 1 linha)
  const { count: gamCount } = await admin
    .from("gam_placement_revenue")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("site_id", siteId)
    .eq("date", yesterday);
  if (!gamCount || gamCount === 0) return { ok: false, reason: "no_gam_revenue_yesterday" };

  // 3. placements Ads de ontem para a conta (precisa ter pelo menos 1 linha)
  const { count: adsCount } = await admin
    .from("ads_placements")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("google_account_id", googleAccountId)
    .eq("date", yesterday);
  if (!adsCount || adsCount === 0) return { ok: false, reason: "no_ads_placements_yesterday" };

  return { ok: true };
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
