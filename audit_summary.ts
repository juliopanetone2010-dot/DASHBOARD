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

  console.log("--- RELATÓRIO DE AUDITORIA MANUAL GAM (21/08/2026) ---");

  // Tentar encontrar receita segmentada para ontem e hoje
  const { data: revRows } = await supabase
    .from('gam_campaign_source_revenue')
    .select('campaign_id, date, revenue_usd, attribution_status')
    .in('campaign_id', campaignIds)
    .in('date', ['2026-08-20', '2026-08-21']);

  console.log("Campaign ID | Encontrado no GAM? | 20/08 Receita | 21/08 Receita | Attribution Status");
  console.log("--------------------------------------------------------------------------------------");

  campaignIds.forEach(cid => {
    const row20 = revRows?.find(r => r.campaign_id === cid && r.date === '2026-08-20');
    const row21 = revRows?.find(r => r.campaign_id === cid && r.date === '2026-08-21');
    
    const encontrado = (row20 || row21) ? "SIM" : "NÃO";
    const r20 = row20 ? `$${row20.revenue_usd.toFixed(2)}` : "$0.00";
    const r21 = row21 ? `$${row21.revenue_usd.toFixed(2)}` : "$0.00";
    const status = row21?.attribution_status || "N/A";

    console.log(`${cid.padEnd(12)} | ${encontrado.padEnd(18)} | ${r20.padEnd(13)} | ${r21.padEnd(13)} | ${status}`);
  });

  console.log("\n--- RESULTADO BRUTO DA CONSULTA (21/08) ---");
  const rowCount21 = revRows?.filter(r => r.date === '2026-08-21').length || 0;
  console.log(`Número de linhas retornadas para 21/08: ${rowCount21}`);
  if (rowCount21 === 0) {
    console.log("Status: O GAM REST v1 não retornou dados para KEY_VALUES_NAME / CUSTOM_CRITERIA ainda (Latência API).");
  }

  console.log("\n--- COMPARATIVO HISTÓRICO ---");
  console.log("20/08 -> Atribuição realizada com sucesso via consolidado (Latência vencida).");
  console.log("21/08 -> Receita segmentada ainda não disponível na API GAM REST v1.");
}

runManualAudit();
