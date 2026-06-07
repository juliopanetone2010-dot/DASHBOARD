// Atualiza tabela exchange_rates com cotações para BRL.
// Ordem de prioridade (para USD->BRL, taxa COMERCIAL próxima da real):
//   1) AwesomeAPI (bid comercial, ~tempo real)
//   2) BCB PTAX (oficial, dia útil anterior)
//   3) Frankfurter (BCE, diário)
//   4) open.er-api (fallback global, 1x/dia)
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
  // 1) AwesomeAPI — taxa comercial bid (~tempo real, melhor pra USD->BRL)
  try {
    const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${from}-${to}`, {
      headers: { "User-Agent": "Mozilla/5.0 fx-sync" },
    });
    if (res.ok) {
      const data = await res.json();
      const key = `${from}${to}`;
      const rate = Number(data?.[key]?.bid);
      if (Number.isFinite(rate) && rate > 0) {
        debug.push(`[fx] ${from}->${to} ${rate} (awesomeapi)`);
        return { rate, source: "awesomeapi" };
      }
    } else {
      debug.push(`[fx] awesomeapi ${from}->${to} HTTP ${res.status}`);
    }
  } catch (e) {
    debug.push(`[fx] awesomeapi ${from}->${to} falhou: ${String(e)}`);
  }

  // 2) BCB PTAX (apenas USD->BRL e EUR->BRL via série específica). Usa últimos 10 dias e pega a mais recente.
  if (to === "BRL" && (from === "USD" || from === "EUR")) {
    try {
      const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
      const end = new Date();
      const start = new Date(); start.setDate(end.getDate() - 10);
      const endpoint = from === "USD" ? "CotacaoDolarPeriodo" : "CotacaoMoedaPeriodoFechamento";
      const url = from === "USD"
        ? `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${fmt(start)}'&@dataFinalCotacao='${fmt(end)}'&$format=json&$top=20&$orderby=dataHoraCotacao desc`
        : `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodoFechamento(codigoMoeda=@codigoMoeda,dataInicialCotacao=@dataInicialCotacao,dataFinalCotacao=@dataFinalCotacao)?@codigoMoeda='EUR'&@dataInicialCotacao='${fmt(start)}'&@dataFinalCotacao='${fmt(end)}'&$format=json&$top=20&$orderby=dataHoraCotacao desc`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const last = (data?.value ?? []).sort((a: any, b: any) => String(b.dataHoraCotacao).localeCompare(String(a.dataHoraCotacao)))[0];
        const compra = Number(last?.cotacaoCompra);
        const venda = Number(last?.cotacaoVenda);
        const rate = (Number.isFinite(compra) && Number.isFinite(venda)) ? (compra + venda) / 2 : (Number.isFinite(venda) ? venda : compra);
        if (Number.isFinite(rate) && rate > 0) {
          debug.push(`[fx] ${from}->${to} ${rate} (bcb-ptax ${last?.dataHoraCotacao})`);
          return { rate, source: "bcb-ptax" };
        }
      } else {
        debug.push(`[fx] bcb ${from}->${to} HTTP ${res.status}`);
      }
    } catch (e) {
      debug.push(`[fx] bcb ${from}->${to} falhou: ${String(e)}`);
    }
  }

  // 3) Frankfurter (BCE, diário)
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`);
    if (res.ok) {
      const data = await res.json();
      const rate = Number(data?.rates?.[to]);
      if (Number.isFinite(rate) && rate > 0) {
        debug.push(`[fx] ${from}->${to} ${rate} (frankfurter)`);
        return { rate, source: "frankfurter" };
      }
    }
  } catch (e) {
    debug.push(`[fx] frankfurter ${from}->${to} falhou: ${String(e)}`);
  }

  // 4) open.er-api (fallback global, 1x/dia)
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
