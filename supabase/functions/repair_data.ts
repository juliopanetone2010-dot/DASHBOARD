import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function repair() {
  const siteId = "28404d69-ba48-432c-ae7c-2610f79ab81f"; // Universo Dos Cartoes
  const userId = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
  console.log(`Starting repair for Site: ${siteId}`);

  const headers = {
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };

  // 1. Trigger Google Ads Sync (Spend)
  console.log("Triggering google-ads-sync-campaigns...");
  const adsRes = await fetch(`${SUPABASE_URL}/functions/v1/google-ads-sync-campaigns`, {
    method: "POST",
    headers,
    body: JSON.stringify({ site_id: siteId, date_preset: "LAST_7_DAYS", user_id: userId })
  });
  console.log("Ads Sync Result:", await adsRes.text());

  // 2. Trigger GAM Sync (Revenue)
  console.log("Triggering gam-sync-revenue...");
  // Use the service role key directly in the header and body
  const gamRes = await fetch(`${SUPABASE_URL}/functions/v1/gam-sync-revenue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ 
      site_id: siteId, 
      date_preset: "LAST_7_DAYS", 
      sync: true, 
      user_id: userId 
    })
  });
  console.log("GAM Sync Result:", await gamRes.text());

  console.log("Repair complete.");
}

repair();


