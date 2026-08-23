import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const userId = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
const siteId = "28404d69-ba48-432c-ae7c-2610f79ab81f"; // Universo Dos Cartões
const fxRate = 5.1549;

async function syncDailyMetrics() {
  console.log("Starting final sync of daily_metrics for Universo Dos Cartões...");
  
  const dates = ["2026-08-21", "2026-08-22"];
  
  for (const date of dates) {
    console.log(`\nDate: ${date}`);
    
    // 1. Get ALL attributed revenue for this site/date
    const { data: revs } = await admin
      .from("gam_campaign_source_revenue")
      .select("*")
      .eq("site_id", siteId)
      .eq("date", date)
      .eq("utm_source", "google");
      
    if (!revs || revs.length === 0) {
      console.log(`No attributed revenue found for ${date}`);
      continue;
    }

    // 2. We need to find the google_account_id. 
    // Let's get it from any campaign of this site.
    const { data: campaigns } = await admin
      .from("campaigns")
      .select("google_account_id")
      .eq("user_id", userId)
      .limit(1);
      
    const googleAccountId = campaigns?.[0]?.google_account_id;
    if (!googleAccountId) {
      console.error("Could not find a google_account_id for user.");
      return;
    }

    for (const r of revs) {
      const cid = r.campaign_id;
      if (cid === "__aggregate__") continue;

      const revenueUsd = Number(r.revenue_usd || 0);
      const revenueBrl = revenueUsd * fxRate;
      
      // We don't have spend in logs, let's look if there's any spend in daily_metrics already
      // or just upsert with 0 spend and correct revenue.
      const { data: existing } = await admin
        .from("daily_metrics")
        .select("*")
        .eq("site_id", siteId)
        .eq("date", date)
        .eq("campaign_id", cid)
        .maybeSingle();

      const spendBrl = Number(existing?.spend || 0);
      const profit = revenueBrl - spendBrl;
      
      console.log(`CID ${cid}: Rev R$ ${revenueBrl.toFixed(2)} | ROI ${spendBrl > 0 ? ((profit/spendBrl)*100).toFixed(2) : '100'}%`);

      await admin.from("daily_metrics").upsert({
        user_id: userId,
        site_id: siteId,
        google_account_id: googleAccountId, // MANDATORY for the view to join correctly
        campaign_id: cid,
        date: date,
        spend: spendBrl,
        revenue: revenueUsd,
        profit: profit,
        roi: spendBrl > 0 ? (profit / spendBrl) * 100 : (revenueBrl > 0 ? 100 : 0),
        roas: spendBrl > 0 ? revenueBrl / spendBrl : 0,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,site_id,campaign_id,date" });
    }
  }
  console.log("\nSync finished.");
}

syncDailyMetrics();
