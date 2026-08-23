import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const userId = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
const siteId = "28404d69-ba48-432c-ae7c-2610f79ab81f"; // Universo Dos Cartões

async function fixAll() {
  console.log("Starting full sync of spend and revenue for Universo Dos Cartões...");
  
  const dates = ["2026-08-21", "2026-08-22", "2026-08-23"];
  
  for (const date of dates) {
    console.log(`\nDate: ${date}`);
    
    // 1. Get ALL metrics from the log/staging table where Google Ads sync landed
    const { data: adsSyncs } = await admin
      .from("google_ads_sync_logs")
      .select("*")
      .eq("site_id", siteId)
      .eq("date", date);
      
    console.log(`Found ${adsSyncs?.length || 0} Google Ads sync log entries.`);
    
    for (const log of adsSyncs || []) {
      const cid = log.campaign_id;
      const spendBrl = Number(log.cost_micros || 0) / 1_000_000;
      
      // 2. Get attributed revenue for this CID
      const { data: revData } = await admin
        .from("gam_campaign_source_revenue")
        .select("revenue_usd")
        .eq("site_id", siteId)
        .eq("date", date)
        .eq("campaign_id", cid)
        .eq("utm_source", "google")
        .maybeSingle();

      const revenueUsd = Number(revData?.revenue_usd || 0);
      const revenueBrl = revenueUsd * 5.1549;
      const profit = revenueBrl - spendBrl;
      const roi = spendBrl > 0 ? (profit / spendBrl) * 100 : (revenueBrl > 0 ? 100 : 0);
      
      console.log(`CID ${cid}: Spend R$ ${spendBrl.toFixed(2)} | Rev $${revenueUsd.toFixed(2)} | ROI ${roi.toFixed(2)}%`);
      
      // 3. Upsert into daily_metrics
      await admin.from("daily_metrics").upsert({
        user_id: userId,
        site_id: siteId,
        campaign_id: cid,
        date: date,
        spend: spendBrl,
        revenue: revenueUsd,
        profit: profit,
        roi: roi,
        roas: spendBrl > 0 ? revenueBrl / spendBrl : 0,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,site_id,campaign_id,date" });
    }
  }
  console.log("\nSync finished.");
}

fixAll();
