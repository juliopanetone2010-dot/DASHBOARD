import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const userId = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
const siteId = "28404d69-ba48-432c-ae7c-2610f79ab81f"; // Universo Dos Cartões

async function fixSpend() {
  console.log("Fetching actual spend from Google Ads sync logs...");
  
  const { data: adsSyncs } = await admin
    .from("google_ads_sync_logs")
    .select("*")
    .eq("site_id", siteId)
    .in("date", ["2026-08-21", "2026-08-22"]);
    
  console.log(`Found ${adsSyncs?.length || 0} sync logs.`);
  
  for (const log of adsSyncs || []) {
    const date = log.date;
    const cid = log.campaign_id;
    const spendBrl = Number(log.cost_micros || 0) / 1_000_000;
    
    if (spendBrl > 0) {
      console.log(`Updating Spend for CID ${cid} on ${date}: R$ ${spendBrl.toFixed(2)}`);
      
      const { data: existing } = await admin
        .from("daily_metrics")
        .select("*")
        .eq("site_id", siteId)
        .eq("date", date)
        .eq("campaign_id", cid)
        .maybeSingle();
        
      if (existing) {
        const revBrl = Number(existing.revenue || 0) * 5.1549; // revenue is stored in USD
        const profit = revBrl - spendBrl;
        const roi = spendBrl > 0 ? (profit / spendBrl) * 100 : 0;
        
        await admin.from("daily_metrics").update({
          spend: spendBrl,
          profit: profit,
          roi: roi,
          roas: spendBrl > 0 ? revBrl / spendBrl : 0
        }).eq("id", existing.id);
      }
    }
  }
  console.log("Spend fix finished.");
}

fixSpend();
