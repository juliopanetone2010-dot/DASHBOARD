
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function audit() {
  const date = '2026-08-21';
  const siteId = '28404d69-ba48-432c-ae7c-2610f79ab81f'; // Universo dos Cartões
  
  console.log(`--- Auditoria para ${date} ---`);

  // 1. Verificar site_metrics_daily
  const { data: metrics } = await supabase
    .from('site_metrics_daily')
    .select('revenue, impressions')
    .eq('site_id', siteId)
    .eq('date', date)
    .single();
  
  console.log(`Receita Geral (site_metrics_daily): R$ ${metrics?.revenue || 0}`);

  // 2. Verificar gam_campaign_source_revenue
  const { data: campaignRev } = await supabase
    .from('gam_campaign_source_revenue')
    .select('campaign_id, revenue, source, attribution_status, updated_at')
    .eq('site_id', siteId)
    .eq('date', date);

  console.log(`Registros em gam_campaign_source_revenue: ${campaignRev?.length || 0}`);
  if (campaignRev && campaignRev.length > 0) {
    campaignRev.forEach(r => {
      console.log(` - ID: ${r.campaign_id} | Rev: ${r.revenue} | Status: ${r.attribution_status} | Source: ${r.source}`);
    });
  }

  // 3. Verificar se existem URLs mapeadas para hoje
  const { data: urls } = await supabase
    .from('campaign_final_urls')
    .select('count')
    .eq('user_id', '1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9');
  
  console.log(`URLs no cache (campaign_final_urls): ${urls?.[0]?.count || 0}`);
}

audit();
