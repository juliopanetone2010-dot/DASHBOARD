// Atualiza tabela exchange_rates com cotações para BRL.
// Estratégia: tenta awesomeapi (Banco Central BR) primeiro, fallback open.er-api.
// Pode ser invocada manualmente OU agendada via pg_cron 1x/dia.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const PAIRS: Array<{ from: string; to: string }> = [
  { from: "USD", to: "BRL" },
  { from: "EUR", to: "BRL" },
  { from: "GBP", to: "BRL" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const debug: string[] = [];
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const results: Array<{ from: string; to: string; rate: number; source: string }> = [];
    for (const p of PAIRS) {
      const r = await fetchPair(p.from, p.to, debug);
      if (r) {
        await admin.from("exchange_rates").upsert({
          from_currency: p.from, to_currency: p.to, rate: r.rate, source: r.source,
          updated_at: new Date().toISOString(),
        }, { onConflict: "from_currency,to_currency" });
        results.push({ from: p.from, to: p.to, ...r });
      }
    }
    return json({ ok: true, results, debug });
  } catch (e) {
    return json({ error: String(e), debug }, 500);
  }
});

async function fetchPair(from: string, to: string, debug: string[]): Promise<{ rate: number; source: string } | null> {
  // 1) awesomeapi (mais preciso para BRL)
  if (to === "BRL") {
    try {
      const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${from}-${to}`);
      const data = await res.json();
      const key = `${from}${to}`;
      const rate = Number(data?.[key]?.bid);
      if (Number.isFinite(rate) && rate > 0) {
        debug.push(`[fx] ${from}->${to} ${rate} (awesomeapi)`);
        return { rate, source: "awesomeapi" };
      }
    } catch (e) {
      debug.push(`[fx] awesomeapi ${from}->${to} falhou: ${String(e)}`);
    }
  }
  // 2) open.er-api (fallback global)
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    const data = await res.json();
    const rate = Number(data?.rates?.[to]);
    if (Number.isFinite(rate) && rate > 0) {
      debug.push(`[fx] ${from}->${to} ${rate} (open.er-api)`);
      return { rate, source: "open.er-api" };
    }
  } catch (e) {
    debug.push(`[fx] open.er-api ${from}->${to} falhou: ${String(e)}`);
  }
  return null;
}

function json(p: unknown, status = 200) {
  return new Response(JSON.stringify(p), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
