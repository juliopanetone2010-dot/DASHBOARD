// bg-sync-push-retention
// Cron wrapper: itera por todos os sites com network_code e chama gam-sync-push-retention
// usando service role. Roda em background pra não estourar tempo de execução do cron.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // intervalo padrão: últimos 3 dias (cobre revisões tardias do GAM sem ser pesado)
  let days = 3;
  try {
    const body = await req.json().catch(() => ({} as any));
    if (Number.isFinite(Number(body?.days))) days = Math.max(1, Math.min(30, Number(body.days)));
  } catch (_) { /* */ }

  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const fromDate = new Date(today);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);

  const { data: sites, error } = await admin
    .from("sites")
    .select("id, user_id, name, network_code")
    .not("network_code", "is", null);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const work = (async () => {
    const results: Array<{ site: string; ok: boolean; error?: string; inserted?: number }> = [];
    for (const s of sites ?? []) {
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/gam-sync-push-retention`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json",
            apikey: SERVICE_KEY,
          },
          body: JSON.stringify({ site_id: s.id, user_id: s.user_id, from, to }),
        });
        const j = await r.json().catch(() => ({} as any));
        if (!r.ok) {
          results.push({ site: s.name, ok: false, error: j?.error ?? `HTTP ${r.status}` });
        } else {
          results.push({ site: s.name, ok: true, inserted: j?.inserted ?? 0 });
        }
      } catch (e) {
        results.push({ site: s.name, ok: false, error: String((e as Error).message ?? e) });
      }
    }
    console.log("[bg-sync-push-retention] done", JSON.stringify({ from, to, results }));
  })();

  // @ts-ignore EdgeRuntime.waitUntil disponível no runtime do Supabase
  if (typeof EdgeRuntime !== "undefined" && (EdgeRuntime as any).waitUntil) {
    // @ts-ignore
    (EdgeRuntime as any).waitUntil(work);
  } else {
    work.catch((e) => console.error("[bg-sync-push-retention] bg error", e));
  }

  return new Response(JSON.stringify({ ok: true, status: "started", sites: sites?.length ?? 0, from, to }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
