import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

async function checkData() {
  const yesterday = "2026-08-21";
  console.log(`Auditing DB for: ${yesterday}`);

  const { data: campaignSourceRev } = await supabase
    .from('gam_campaign_source_revenue')
    .select('campaign_id, revenue_usd, attribution_status, date')
    .eq('date', yesterday);
  
  console.log('GAM Campaign Source Revenue (Yesterday):', campaignSourceRev?.length || 0, 'rows');
  if (campaignSourceRev && campaignSourceRev.length > 0) {
    console.log('Sample rows:', campaignSourceRev.slice(0, 5));
  }

  const { data: metrics } = await supabase
    .from('campaign_country_metrics')
    .select('campaign_id, revenue, date')
    .eq('date', yesterday)
    .gt('revenue', 0);
  
  console.log('Campaign Country Metrics (Yesterday with Revenue):', metrics?.length || 0, 'rows');
}

checkData();
