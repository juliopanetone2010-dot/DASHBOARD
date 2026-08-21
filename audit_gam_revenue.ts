import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const SUPABASE_URL = "https://pxlgkpuaaptbubsnvfkz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4bGdrcHVhYXB0YnVic252Zmt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3Mzk0NjksImV4cCI6MjA5MzMxNTQ2OX0.tIykqWOZ9g0CChP60wcpq_q6c2jL9UkrMaTA02UTNww";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function runAudit() {
  const campaignIds = [
    "23309079322", "23021142139", "23450729920", "23036874694",
    "22923001384", "23026320710", "22922896278", "23446177394",
    "23736616702", "22974787890"
  ];

  console.log("--- INÍCIO DA AUDITORIA DE ATRIBUIÇÃO GAM (DENO) ---");
  console.log("Data Alvo: 2026-08-21 (Hoje)");
  console.log("Data Comparação: 2026-08-20 (Ontem)");

  // 1. Consulta no Banco de Dados (Estado Atual) - Usando campaign_id
  const { data: dbRows, error: dbError } = await supabase
    .from('gam_campaign_source_revenue')
    .select('*')
    .in('campaign_id', campaignIds)
    .in('date', ['2026-08-20', '2026-08-21']);

  if (dbError) {
    console.error("Erro ao consultar banco:", dbError);
  } else {
    console.log("\n--- RESULTADOS ATUAIS NO BANCO ---");
    console.log("Campaign ID | 20/08 (Receita USD) | 21/08 (Receita USD) | Status 21/08");
    console.log("---------------------------------------------------------------");

    campaignIds.forEach(cid => {
      const row20 = dbRows.find(r => r.campaign_id === cid && r.date === '2026-08-20');
      const row21 = dbRows.find(r => r.campaign_id === cid && r.date === '2026-08-21');
      
      const rev20 = row20 ? `$${row20.revenue_usd.toFixed(2)}` : "$0.00";
      const rev21 = row21 ? `$${row21.revenue_usd.toFixed(2)}` : "$0.00";
      const status21 = row21?.attribution_status || "Não encontrado";
      
      console.log(`${cid.padEnd(12)} | ${rev20.padEnd(15)} | ${rev21.padEnd(15)} | ${status21}`);
    });
  }

  // 2. Acionamento do Sincronizador Manual via Edge Function
  console.log("\n--- ACIONANDO SINCRONIZAÇÃO MANUAL (GAM-SYNC-REVENUE) ---");
  try {
    const { data: syncData, error: syncFuncError } = await supabase.functions.invoke('gam-sync-revenue', {
      body: {
        date_preset: "CUSTOM",
        start_date: "2026-08-21",
        end_date: "2026-08-21",
        force_consolidated: true,
        debug_campaigns: campaignIds
      }
    });

    if (syncFuncError) {
      console.error("Erro na Edge Function:", syncFuncError);
    } else {
      console.log("Resposta da Função:", JSON.stringify(syncData, null, 2));
    }
  } catch (e) {
    console.error("Erro ao invocar função:", e);
  }
  
  console.log("\n--- FIM DA AUDITORIA ---");
}

runAudit();
