
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const userId = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
const siteId = "28404d69-ba48-432c-ae7c-2610f79ab81f"; // Universo Dos Cartões
const fxRate = 5.1549; 

async function repair() {
  console.log("Starting manual data repair for Universo Dos Cartões (21/08 - 22/08)...");

  // Dados auditados da AI em turnos anteriores para 22/08
  // 23309079322: $2,655.02
  // 23207554976: $415.11
  // 22923001384: $3.46
  // Unattributed (__aggregate__): Resto do site (Total site 22/08 foi ~$5,673.88)
  
  const dates = ["2026-08-21", "2026-08-22"];
  
  for (const date of dates) {
    console.log(`Processing ${date}...`);
    
    // 1. Get ALL metrics for this site on this date (don't filter by user_id yet if unsure)
    const { data: metrics, error: mError } = await admin
      .from("google_ads_campaign_performance")
      .select("*")
      .eq("site_id", siteId)
      .eq("date", date);
      
    if (mError) {
      console.error(`Error fetching metrics for ${date}:`, mError);
      continue;
    }

    if (!metrics || metrics.length === 0) {
      console.log(`No metrics found in google_ads_campaign_performance for ${date}`);
      continue;
    }
    
    console.log(`Found ${metrics.length} campaigns in google_ads_campaign_performance.`);
    
    for (const m of metrics) {
      const cid = String(m.campaign_id);
      
      // Get revenue from source_revenue table
      const { data: revData } = await admin
        .from("gam_campaign_source_revenue")
        .select("revenue_usd")
        .eq("site_id", siteId)
        .eq("date", date)
        .eq("campaign_id", cid)
        .eq("utm_source", "google")
        .maybeSingle();

      const revenueUsd = Number(revData?.revenue_usd || 0);
      const spendBrl = Number(m.cost_micros || 0) / 1_000_000;
      const revenueBrl = revenueUsd * fxRate;
      const profit = revenueBrl - spendBrl;
      const roi = spendBrl > 0 ? (profit / spendBrl) * 100 : (revenueBrl > 0 ? 100 : 0);
      const roas = spendBrl > 0 ? revenueBrl / spendBrl : 0;
      
      console.log(`Updating CID ${cid}: Rev USD $${revenueUsd.toFixed(2)} | Spend BRL R$${spendBrl.toFixed(2)} | ROI ${roi.toFixed(2)}%`);
      
      // Upsert into daily_metrics
      const { error: upsertError } = await admin.from("daily_metrics").upsert({
        user_id: m.user_id,
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

      if (upsertError) {
        console.error(`Error upserting daily_metrics for CID ${cid}:`, upsertError);
      }
    }
  }
  
  console.log("Repair finished.");
}

repair();
