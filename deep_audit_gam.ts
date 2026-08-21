import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const SUPABASE_URL = "https://pxlgkpuaaptbubsnvfkz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4bGdrcHVhYXB0YnVic252Zmt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3Mzk0NjksImV4cCI6MjA5MzMxNTQ2OX0.tIykqWOZ9g0CChP60wcpq_q6c2jL9UkrMaTA02UTNww";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function runDetailedAudit() {
  const campaignIds = [
    "23309079322", "23021142139", "23450729920", "23036874694",
    "22923001384", "23026320710", "22922896278", "23446177394",
    "23736616702", "22974787890"
  ];

  console.log("--- AUDITORIA DETALHADA GAM REAL-TIME ---");
  
  // 1. Verificar se existe receita consolidada no nível do site para hoje
  const { data: siteRevenue } = await supabase
    .from('daily_metrics')
    .select('revenue, date')
    .eq('date', '2026-08-21');
  
  console.log(`Receita total do site hoje (21/08): R$ ${siteRevenue?.[0]?.revenue || 0}`);

  // 2. Tentar encontrar qualquer registro de receita segmentada (mesmo que $0)
  const { data: campaignRows } = await supabase
    .from('gam_campaign_source_revenue')
    .select('*')
    .in('campaign_id', campaignIds)
    .in('date', ['2026-08-20', '2026-08-21'])
    .order('date', { ascending: false });

  console.log("\nCampaign ID | Data | Receita USD | Attribution Status");
  console.log("-----------------------------------------------------");
  campaignIds.forEach(cid => {
    const rows = campaignRows?.filter(r => r.campaign_id === cid) || [];
    if (rows.length === 0) {
      console.log(`${cid.padEnd(12)} | -    | $0.00       | Não encontrado`);
    } else {
      rows.forEach(r => {
        console.log(`${cid.padEnd(12)} | ${r.date} | $${r.revenue_usd.toFixed(2).padEnd(10)} | ${r.attribution_status}`);
      });
    }
  });

  // 3. Executar sincronização manual com DEBUG ativado para ver logs de processamento
  console.log("\nExecutando sincronização manual profunda...");
  const { data: syncData, error } = await supabase.functions.invoke('gam-sync-revenue', {
    body: {
      date_preset: "CUSTOM",
      start_date: "2026-08-21",
      end_date: "2026-08-21",
      force_consolidated: true,
      use_url_fallback: true,
      debug: true
    }
  });

  if (error) {
    console.error("Erro na função:", error);
  } else {
    console.log("Resultado da Sincronização:", JSON.stringify(syncData, null, 2));
  }
}

runDetailedAudit();
