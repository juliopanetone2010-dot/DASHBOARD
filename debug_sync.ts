import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function testSync() {
  console.log("Starting debug sync (Direct Deno RunSync)...");
  
  // We simulate a body directly to a local test to verify runSync logic
  // but since we can't call runSync from here, we continue using fetch
  // but we add logs to ensure we are seeing why data isn't returning.
  
  const payload = {
    sync: true,
    date_preset: "LAST_7_DAYS",
    test: true,
    include_full_reports: true,
    revenue_only: false,
    site_metrics_only: false,
    user_id: "68c92a7e-4b72-4d2c-8068-d0f507b9a5e2"
  };

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/gam-sync-revenue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    const text = await res.text();
    console.log("Raw Response status:", res.status);
    console.log("Raw Response text:", text.slice(0, 1000));
    
    try {
      const data = JSON.parse(text);
      if (data.debug) {
        console.log("Debug Logs:", JSON.stringify(data.debug, null, 2));
      }
    } catch(e) {
      console.log("Failed to parse JSON response");
    }
  } catch (e) {
    console.error("Fetch failed:", e);
  }
}

testSync();
