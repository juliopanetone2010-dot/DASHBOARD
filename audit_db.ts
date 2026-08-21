
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
}

audit();
