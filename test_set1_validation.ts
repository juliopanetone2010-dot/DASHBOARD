import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL")!;
const supabaseKey = Deno.env.get("VITE_SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testSet1() {
  console.log("Validando Set 1 (Universo dos Cartões) para 2026-08-21...");

  // Buscar dados de hoje para o Set 1
  const { data: adsData, error: adsError } = await supabase
    .from('google_ads_campaign_metrics')
    .select('campaign_name, cost_micros, impressions, clicks')
    .eq('date', '2026-08-21')
    .ilike('campaign_name', '%[LIGADO360]%'); // LIGADO360 é o padrão do Universo

  if (adsError) {
    console.error("Erro ao buscar dados:", adsError);
    return;
  }

  const totalCostMicros = adsData?.reduce((sum, row) => sum + Number(row.cost_micros), 0) || 0;
  const totalCostBRL = totalCostMicros / 1_000_000;
  
  console.log("Campanhas encontradas:", adsData?.length);
  console.log("Gasto Total (BRL):", totalCostBRL.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  console.log("metrics.cost_micros:", totalCostMicros);
  
  // Imagem enviada mostra R$ 3,98 mil para a conta selecionada no print.
  // O usuário disse "OS GASTOS DO UNIVERSO FORAM ESSES" com um print de R$ 3,98 mil.
  // O valor de R$ 382.587,70 era o total do dashboard no print anterior.
}

testSet1();
