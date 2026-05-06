// Revisa todos os dias do mês anterior, regenerando snapshots com dados atualizados do GAM/Ads.
// Roda via cron no dia 1 de cada mês às 00:00 BRT (03:00 UTC).
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

    // Determina mês anterior em BRT (UTC-3)
    const nowBrt = new Date(Date.now() - 3 * 3600_000);
    const y = nowBrt.getUTCFullYear();
    const m = nowBrt.getUTCMonth(); // mês atual 0-11; mês anterior = m-1
    const prevMonthDate = new Date(Date.UTC(y, m - 1, 1));
    const prevYear = prevMonthDate.getUTCFullYear();
    const prevMonth = prevMonthDate.getUTCMonth(); // 0-11
    const lastDay = new Date(Date.UTC(prevYear, prevMonth + 1, 0)).getUTCDate();

    // Lista todos os sites
    const { data: sites, error: sErr } = await admin.from("sites").select("id, name");
    if (sErr) throw sErr;

    const results: any[] = [];
    for (let day = 1; day <= lastDay; day++) {
      const date = ymd(new Date(Date.UTC(prevYear, prevMonth, day)));
      for (const site of sites ?? []) {
        try {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/generate-daily-snapshot`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SERVICE_ROLE}`,
              apikey: SERVICE_ROLE,
            },
            body: JSON.stringify({ date, site_id: site.id, force: true }),
          });
          results.push({ date, site_id: site.id, ok: r.ok });
        } catch (e: any) {
          results.push({ date, site_id: site.id, ok: false, error: String(e?.message ?? e) });
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: true, month: `${prevYear}-${String(prevMonth + 1).padStart(2, "0")}`, processed: results.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
