import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

async function checkData() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`Auditing DB for: ${today}`);

  const { data: campaignSourceRev } = await supabase
    .from('gam_campaign_source_revenue')
    .select('campaign_id, revenue_usd, attribution_status, date')
    .eq('date', today);
  
  console.log('GAM Campaign Source Revenue (Today):', campaignSourceRev?.length || 0, 'rows');
  if (campaignSourceRev && campaignSourceRev.length > 0) {
    console.log('Sample rows:', campaignSourceRev.slice(0, 5));
  }

  const { data: metrics } = await supabase
    .from('campaign_country_metrics')
    .select('campaign_id, revenue, date')
    .eq('date', today)
    .gt('revenue', 0);
  
  console.log('Campaign Country Metrics (Today with Revenue):', metrics?.length || 0, 'rows');

  // Check if there are any errors logged in sync_status recently
  const { data: syncLogs } = await supabase
    .from('sync_status')
    .select('*')
    .order('last_sync', { ascending: false })
    .limit(5);
  
  console.log('Recent Sync Logs:', JSON.stringify(syncLogs, null, 2));
}

checkData();
