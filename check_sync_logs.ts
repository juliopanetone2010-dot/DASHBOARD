import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL")!;
const supabaseKey = Deno.env.get("VITE_SUPABASE_ANON_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSync() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`Checking data for: ${today}`);

  // Check site revenue
  const { data: metrics } = await supabase
    .from('daily_metrics')
    .select('revenue, date')
    .eq('date', today);
  
  console.log('Daily Metrics (Site Revenue):', metrics);

  // Check campaign revenue
  const { data: campaignRev } = await supabase
    .from('gam_campaign_source_revenue')
    .select('campaign_id, revenue_usd, attribution_status')
    .eq('date', today)
    .limit(10);
  
  console.log('Campaign Revenue (Sample):', campaignRev);

  // Check for errors in sync status or similar
  const { data: status } = await supabase
    .from('sync_status')
    .select('*')
    .order('last_sync', { ascending: false })
    .limit(5);
  
  console.log('Sync Status:', status);
}

checkSync();
