import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/gam-sync-revenue`;

const AUDIT_USER_ID = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
const TARGET_CIDS = ["23207554976", "23309079322", "22923001384"];

async function runAudit() {
  console.log("--- STARTING END-TO-END AUDIT FOR HOJE (TODAY) ---");
  
  // 1. Trigger manual sync for TODAY with deep logging
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify({
      skipAuth: true,
      target_user: AUDIT_USER_ID,
      date_preset: "TODAY",
      include_full_reports: true,
      mode: "full_audit"
    })
  });

  const data = await response.json();
  const logs = data.debug || [];
  
  console.log("\n--- STEP 1: BRUTO API RESPONSE TRACE ---");
  TARGET_CIDS.forEach(cid => {
    const rawMatches = logs.filter(l => l.includes(cid) && (l.includes("SOAP Row") || l.includes("parsing row")));
    if (rawMatches.length > 0) {
      console.log(`[CID ${cid}] Raw API matches found:`);
      rawMatches.forEach(m => console.log(`  > ${m}`));
    } else {
      console.log(`[CID ${cid}] NO literal match found in raw API response logs.`);
    }
  });

  console.log("\n--- STEP 2: PIPELINE TRACE ---");
  // Check if parser identified them
  const parserLogs = logs.filter(l => l.includes("[attribution]") && TARGET_CIDS.some(cid => l.includes(cid)));
  parserLogs.forEach(l => console.log(l));

  // Check Database
  console.log("\n--- STEP 3: DATABASE VERIFICATION ---");
  const dbCheck = await fetch(`${SUPABASE_URL}/rest/v1/gam_campaign_source_revenue?user_id=eq.${AUDIT_USER_ID}&date=eq.2026-08-22&select=*`, {
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  const dbRows = await dbCheck.json();
  TARGET_CIDS.forEach(cid => {
    const row = dbRows.find(r => String(r.campaign_id) === cid);
    if (row) {
      console.log(`[CID ${cid}] DB Record: Revenue=${row.revenue_brl} BRL, Impressions=${row.impressions}`);
    } else {
      console.log(`[CID ${cid}] NO record found in DB for today.`);
    }
  });

  console.log("\n--- STEP 4: CUSTOM DIMENSION INVESTIGATION ---");
  // We'll add a new tool to fetch Custom Targetings if possible, 
  // but first let's check if the existing logs show any dimension mapping errors
  const customDimLogs = logs.filter(l => l.includes("dimension") || l.includes("Custom"));
  customDimLogs.slice(0, 10).forEach(l => console.log(l));
}

runAudit();
