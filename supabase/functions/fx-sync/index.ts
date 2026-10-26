// Atualiza tabela exchange_rates com cotações para BRL.
// Estratégia: tenta awesomeapi (Banco Central BR) primeiro, fallback open.er-api.
// Pode ser invocada manualmente (botão "Atualizar" da dash) OU agendada via pg_cron.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

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

    // A dash (navegador) consegue a cotação ao vivo da awesomeapi, que bloqueia os IPs do Supabase.
    // Aceita só de usuário logado e só se estiver perto da cotação já salva.
    let usdOverride: number | null = null;
    const body = await req.json().catch(() => ({}));
    const sent = Number((body as any)?.usd_brl);
    if (Number.isFinite(sent) && sent > 0) {
      const authHeader = req.headers.get("Authorization");
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: claims } = authHeader?.startsWith("Bearer ")
        ? await userClient.auth.getClaims(authHeader.replace("Bearer ", ""))
        : { data: null };
      const { data: cur } = await admin.from("exchange_rates").select("rate").eq("from_currency", "USD").eq("to_currency", "BRL").maybeSingle();
      const curRate = Number((cur as any)?.rate);
      const near = !Number.isFinite(curRate) || curRate <= 0 || Math.abs(sent / curRate - 1) <= 0.25;
      if (claims?.claims?.sub && sent > 2 && sent < 12 && near) usdOverride = sent;
      else debug.push(`[fx] usd_brl=${sent} ignorado (sem login ou fora da faixa)`);
    }

    const results: Array<{ from: string; to: string; rate: number; source: string }> = [];
    for (const p of PAIRS) {
      const r = p.from === "USD" && usdOverride ? { rate: usdOverride, source: "awesomeapi" } : await fetchPair(p.from, p.to, debug);
      if (r) {
        const { error } = await admin.from("exchange_rates").upsert({
          from_currency: p.from, to_currency: p.to, rate: r.rate, source: r.source,
          updated_at: new Date().toISOString(),
        }, { onConflict: "from_currency,to_currency" });
        if (error) debug.push(`[fx] upsert ${p.from}->${p.to} falhou: ${error.message}`);
        else results.push({ from: p.from, to: p.to, ...r });
      }
    }
    return json({ ok: true, results, debug });
  } catch (e) {
    return json({ error: String(e), debug }, 500);
  }
});

async function fetchPair(from: string, to: string, debug: string[]): Promise<{ rate: number; source: string } | null> {
  if (to === "BRL") {
    try {
      const token = Deno.env.get("AWESOMEAPI_TOKEN");
      const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${from}-${to}${token ? `?token=${token}` : ""}`);
      const text = await res.text();
      const data = JSON.parse(text);
      const rate = Number(data?.[`${from}${to}`]?.bid);
      if (Number.isFinite(rate) && rate > 0) {
        debug.push(`[fx] ${from}->${to} ${rate} (awesomeapi)`);
        return { rate, source: "awesomeapi" };
      }
      debug.push(`[fx] awesomeapi ${from}->${to} sem cotação: HTTP ${res.status} ${text.slice(0, 200)}`);
    } catch (e) {
      debug.push(`[fx] awesomeapi ${from}->${to} falhou: ${String(e)}`);
    }
  }
  // PTAX do Banco Central: boletim mais recente (atualiza várias vezes ao dia), sem chave e sem cota.
  // A awesomeapi devolve 429 pra IPs do Supabase e a open.er-api só atualiza 1x/dia (fica velha).
  if (from === "USD" && to === "BRL") {
    try {
      const fmt = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`;
      const end = new Date();
      const start = new Date(Date.now() - 7 * 86400_000);
      const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${fmt(start)}'&@dataFinalCotacao='${fmt(end)}'&$orderby=dataHoraCotacao%20desc&$top=1&$format=json`;
      const res = await fetch(url);
      const data = await res.json();
      const row = data?.value?.[0];
      const rate = Number(row?.cotacaoVenda);
      if (Number.isFinite(rate) && rate > 0) {
        debug.push(`[fx] ${from}->${to} ${rate} (bcb-ptax ${row.dataHoraCotacao})`);
        return { rate, source: "bcb-ptax" };
      }
      debug.push(`[fx] bcb-ptax sem cotação: HTTP ${res.status}`);
    } catch (e) {
      debug.push(`[fx] bcb-ptax falhou: ${String(e)}`);
    }
  }
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
