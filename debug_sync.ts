import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function testSync() {
  console.log("Starting debug sync (Deep Audit)...");
  
  const payload = {
    sync: true,
    date_preset: "LAST_7_DAYS",
    test: true,
    include_full_reports: true,
    revenue_only: false,
    site_metrics_only: false,
    user_id: "68c92a7e-4b72-4d2c-8068-d0f507b9a5e2"
  };

  const res = await fetch(`${supabaseUrl}/functions/v1/gam-sync-revenue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  
  const data = await res.json();
  console.log("Response status:", res.status);
  console.log("Full data keys:", Object.keys(data));
  
  if (data.debug) {
    const auditLogs = data.debug.filter((l: string) => 
      l.includes("AUDIT") || 
      l.includes("MATCH_FOUND") ||
      l.includes("23207554976") || 
      l.includes("23309079322") ||
      l.includes("RAW_DATA") ||
      l.includes("network_code") ||
      l.includes("attribut")
    );
    console.log("Audit Logs Found:", JSON.stringify(auditLogs, null, 2));
    if (auditLogs.length === 0) {
      console.log("No specific audit logs found. First 20 logs:");
      console.log(data.debug.slice(0, 20));
    }
  }
  
  if (data.summary) {
    console.log("Summary:", JSON.stringify(data.summary, null, 2));
  }
}

testSync();
