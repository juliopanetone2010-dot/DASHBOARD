// Revisa todos os dias do mês anterior, regenerando snapshots com dados atualizados do GAM/Ads.
// Processa em paralelo e roda em background para não estourar o timeout do request.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ymd(d: Date) { return d.toISOString().slice(0, 10); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Permite override via body: { year, month (1-12), site_ids?: string[] }
    let body: any = {};
    try { body = await req.json(); } catch {}

    const nowBrt = new Date(Date.now() - 3 * 3600_000);
    const defaultY = nowBrt.getUTCFullYear();
    const defaultM = nowBrt.getUTCMonth(); // mês anterior (0-11)
    const prevMonthDate = new Date(Date.UTC(defaultY, defaultM - 1, 1));

    const prevYear = Number(body?.year ?? prevMonthDate.getUTCFullYear());
    const prevMonth = Number(body?.month ? body.month - 1 : prevMonthDate.getUTCMonth()); // 0-11
    const lastDay = new Date(Date.UTC(prevYear, prevMonth + 1, 0)).getUTCDate();

    let sitesQuery = admin.from("sites").select("id, name");
    if (Array.isArray(body?.site_ids) && body.site_ids.length > 0) {
      sitesQuery = sitesQuery.in("id", body.site_ids);
    }
    const { data: sites, error: sErr } = await sitesQuery;
    if (sErr) throw sErr;

    // Monta lista de jobs (dia × site)
    const jobs: Array<{ date: string; site_id: string }> = [];
    for (let day = 1; day <= lastDay; day++) {
      const date = ymd(new Date(Date.UTC(prevYear, prevMonth, day)));
      for (const site of sites ?? []) jobs.push({ date, site_id: site.id });
    }

    // Executa em background em chunks paralelos
    const CHUNK = 8;
    const runAll = async () => {
      for (let i = 0; i < jobs.length; i += CHUNK) {
        const slice = jobs.slice(i, i + CHUNK);
        await Promise.all(slice.map((j) =>
          fetch(`${SUPABASE_URL}/functions/v1/generate-daily-snapshot`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SERVICE_ROLE}`,
              apikey: SERVICE_ROLE,
            },
            body: JSON.stringify({ date: j.date, site_id: j.site_id, force: true }),
          }).catch(() => null),
        ));
      }
    };

    // @ts-ignore Edge runtime background task
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(runAll());
    } else {
      // fallback: dispara sem aguardar
      runAll();
    }

    return new Response(
      JSON.stringify({
        ok: true,
        month: `${prevYear}-${String(prevMonth + 1).padStart(2, "0")}`,
        scheduled: jobs.length,
        sites: sites?.length ?? 0,
        note: "Rodando em background. Aguarde alguns minutos e recarregue o calendário.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
