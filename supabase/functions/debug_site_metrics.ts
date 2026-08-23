import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const userId = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
const siteId = "28404d69-ba48-432c-ae7c-2610f79ab81f"; // Universo Dos Cartões

async function checkSiteMetrics() {
  const dates = ["2026-08-21", "2026-08-22", "2026-08-23"];
  console.log("--- TABLE: site_metrics_daily ---");
  const { data: siteMetrics } = await admin
    .from("site_metrics_daily")
    .select("*")
    .eq("site_id", siteId)
    .in("date", dates);
  console.log(JSON.stringify(siteMetrics, null, 2));
}

checkSiteMetrics();
