import { supabase } from "./src/integrations/supabase/client";

async function testSet1() {
  const { data: adsData, error: adsError } = await supabase
    .from('google_ads_campaign_metrics')
    .select('campaign_name, cost_micros')
    .eq('date', '2026-08-21');

  if (adsError) {
    console.error("Erro:", adsError);
    return;
  }

  const total = adsData?.reduce((sum, r) => sum + Number(r.cost_micros), 0) || 0;
  console.log("Total Micros:", total);
  console.log("Total BRL:", total / 1000000);
  console.log("Count:", adsData?.length);
}
testSet1();
