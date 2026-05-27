// Cron: dispara site-auto-onboard para todos os sites que não sincronizam há > 30 min.
// Roda a cada 15 min via pg_cron.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async () => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  // pega sites cujo last_full_sync_at é antigo (ou nulo) e que não estão processando há < 10 min
  const { data: sites, error } = await admin
    .from("sites")
    .select("id, name, sync_status, sync_started_at, last_full_sync_at")
    .or(`last_full_sync_at.is.null,last_full_sync_at.lt.${cutoff}`);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  const triggered: string[] = [];
  const skipped: string[] = [];
  for (const s of sites ?? []) {
    const startedAt = s.sync_started_at ? new Date(s.sync_started_at).getTime() : 0;
    const ageMin = (Date.now() - startedAt) / 60_000;
    if (s.sync_status === "processing" && ageMin < 10) {
      skipped.push(s.id);
      continue;
    }
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/site-auto-onboard`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVICE_ROLE}`,
          apikey: SERVICE_ROLE,
        },
        body: JSON.stringify({ site_id: s.id, force: true }),
      });
      triggered.push(s.id);
    } catch (e) {
      console.error("[sites-sync-cron] failed", s.id, e);
    }
  }
  return new Response(JSON.stringify({ ok: true, triggered, skipped }), {
    headers: { "Content-Type": "application/json" },
  });
});
