import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function check() {
  const siteId = "28404d69-ba48-432c-ae7c-2610f79ab81f"; // Universo Dos Cartões
  const dates = ["2026-08-21", "2026-08-22", "2026-08-23"];
  
  console.log("--- TABLE: daily_metrics ---");
  const { data: metrics } = await admin
    .from("daily_metrics")
    .select("id, date, campaign_id, spend, revenue, roi, site_id")
    .eq("site_id", siteId)
    .in("date", dates);
  console.log(JSON.stringify(metrics, null, 2));

  console.log("\n--- TABLE: gam_campaign_source_revenue ---");
  const { data: source } = await admin
    .from("gam_campaign_source_revenue")
    .select("*")
    .eq("site_id", siteId)
    .in("date", dates);
  console.log(JSON.stringify(source, null, 2));

  console.log("\n--- TABLE: sites (verification) ---");
  const { data: site } = await admin
    .from("sites")
    .select("id, name")
    .eq("id", siteId)
    .single();
  console.log("Found site:", site?.name, "(", site?.id, ")");
}

check();
