import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const userId = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
const siteId = "28404d69-ba48-432c-ae7c-2610f79ab81f"; // Universo Dos Cartões
const fxRate = 5.1549;

async function repair() {
  console.log("Starting final manual repair using gam_campaign_source_revenue as source...");
  
  const dates = ["2026-08-21", "2026-08-22"];
  
  for (const date of dates) {
    console.log(`Processing ${date}...`);
    
    // Get all attributed revenue for this site/date
    const { data: revs, error: rError } = await admin
      .from("gam_campaign_source_revenue")
      .select("*")
      .eq("site_id", siteId)
      .eq("date", date)
      .eq("utm_source", "google");
      
    if (rError) {
      console.error("Error fetching revenue:", rError);
      continue;
    }

    if (!revs || revs.length === 0) {
      console.log(`No attributed revenue found for ${date}`);
      continue;
    }

    console.log(`Found ${revs.length} revenue records.`);

    for (const r of revs) {
      const cid = r.campaign_id;
      if (cid === "__aggregate__") continue;

      const revenueUsd = Number(r.revenue_usd || 0);
      const revenueBrl = revenueUsd * fxRate;
      
      // Look for spend in daily_metrics (it might already have spend but 0 revenue)
      const { data: existing } = await admin
        .from("daily_metrics")
        .select("*")
        .eq("site_id", siteId)
        .eq("date", date)
        .eq("campaign_id", cid)
        .maybeSingle();

      const spendBrl = Number(existing?.spend || 0);
      const profit = revenueBrl - spendBrl;
      const roi = spendBrl > 0 ? (profit / spendBrl) * 100 : (revenueBrl > 0 ? 100 : 0);
      const roas = spendBrl > 0 ? revenueBrl / spendBrl : 0;

      console.log(`Updating CID ${cid}: Spend R$${spendBrl.toFixed(2)} | Rev R$${revenueBrl.toFixed(2)} | ROI ${roi.toFixed(2)}%`);

      await admin.from("daily_metrics").upsert({
        user_id: r.user_id,
        site_id: siteId,
        campaign_id: cid,
        date: date,
        spend: spendBrl,
        revenue: revenueUsd,
        profit: profit,
        roi: roi,
        roas: roas,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,site_id,campaign_id,date" });
    }
  }
  console.log("Repair finished.");
}

repair();
