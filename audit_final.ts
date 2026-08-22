import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const SUPABASE_URL = "https://pxlgkpuaaptbubsnvfkz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4bGdrcHVhYXB0YnVic252Zmt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3Mzk0NjksImV4cCI6MjA5MzMxNTQ2OX0.tIykqWOZ9g0CChP60wcpq_q6c2jL9UkrMaTA02UTNww";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function runManualAudit() {
  const campaignIds = [
    "23309079322", "23021142139", "23450729920", "23036874694",
    "22923001384", "23026320710", "22922896278", "23446177394",
    "23736616702", "22974787890"
  ];

  console.log("--- AUDITORIA MANUAL PROFUNDA GAM (21/08 vs 20/08) ---");

  // 1. Tentar acionar o sincronizador com força bruta em dimensões específicas
  console.log("Acionando gam-sync-revenue com parâmetros de auditoria...");
  const { data: syncData, error } = await supabase.functions.invoke('gam-sync-revenue', {
    body: {
      date_preset: "CUSTOM",
      start_date: "2026-08-21",
      end_date: "2026-08-21",
      force_consolidated: true,
      debug: true,
      target_campaigns: campaignIds
    }
  });

  if (error) {
    console.error("Erro na função:", error);
  } else {
    console.log("Status da Sincronização:", syncData.status);
    console.log("Mensagem:", syncData.message);
  }

  // 2. Consulta de Comparação Histórica Direta no Banco
  console.log("\nComparando Receita segmentada gravada:");
  console.log("Campaign ID | Gasto Google (Est) | 20/08 Receita | 21/08 Receita | Attribution Status");
  console.log("--------------------------------------------------------------------------------------");

  for (const cid of campaignIds) {
    // Buscar gastos de hoje
    const { data: spends } = await supabase
      .from('daily_metrics')
      .select('cost, revenue')
      .eq('date', '2026-08-21')
      .limit(1); // Simplificado para o site todo já que cost segmentado por id é na tabela campaigns

    const { data: campSpend } = await supabase
      .from('campaigns')
      .select('cost_micros, impressions, clicks')
      .eq('campaign_id', cid)
      .single();
    
    const gasto = campSpend ? `R$ ${(campSpend.cost_micros / 1000000).toFixed(2)}` : "N/A";

    const { data: revRows } = await supabase
      .from('gam_campaign_source_revenue')
      .select('date, revenue_usd, attribution_status')
      .eq('campaign_id', cid)
      .in('date', ['2026-08-20', '2026-08-21']);

    const rev20 = revRows?.find(r => r.date === '2026-08-20')?.revenue_usd || 0;
    const rev21 = revRows?.find(r => r.date === '2026-08-21')?.revenue_usd || 0;
    const status21 = revRows?.find(r => r.date === '2026-08-21')?.attribution_status || "N/A";

    console.log(`${cid.padEnd(12)} | ${gasto.padEnd(16)} | $${rev20.toFixed(2).padEnd(10)} | $${rev21.toFixed(2).padEnd(10)} | ${status21}`);
  }

  console.log("\nNota: Se 21/08 está $0 e status N/A ou predictive, o GAM REST v1 ainda não processou KEY_VALUES_NAME.");
  console.log("Fim da auditoria manual.");
}

runManualAudit();
