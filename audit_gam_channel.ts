import { createClient } from "https://esm.sh/@supabase/supabase-client@2.39.3";
import { getGoogleApiSet } from "./supabase/functions/_shared/google_api_set.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testGamChannelReport() {
  console.log("--- GAM Channel Report Audit ---");
  
  // 1. Get credentials for Set 1 (Universo dos Cartões)
  const credentials = await getGoogleApiSet(supabase, 1);
  if (!credentials) {
    console.error("Failed to load credentials for Set 1");
    return;
  }

  const networkCode = "22953977775"; // From user screenshot
  const targetCampaignId = "23207554976";
  const date = "2026-08-21";

  // Dimension 'Channel' in GAM UI usually maps to 'AD_EXCHANGE_CHANNEL_NAME' or 'AD_EXCHANGE_CHANNEL_ID'
  // But wait, user says "Channel contains 'utm_campaign=23207554976'".
  // In GAM REST v1 API, 'Channel' from the UI typically refers to a custom dimension or a specific Ad Exchange dimension.
  // Actually, 'Channel' in the screenshot provided by user is a dimension in a Historical Report.
  
  // Let's try to list available dimensions or just try the most likely ones.
  // In REST v1, Dimensions are strings like 'DATE', 'AD_UNIT_NAME', etc.
  
  const reportRequest = {
    reportSpec: {
      dateRange: "CUSTOM",
      startDate: { year: 2026, month: 8, day: 21 },
      endDate: { year: 2026, month: 8, day: 21 },
      dimensions: ["DATE", "CUSTOM_CRITERIA"], // We suspect 'Channel' is an alias for a Custom Dimension or Key-Value
      columns: [
        "AD_EXCHANGE_LINE_ITEM_LEVEL_IMPRESSIONS",
        "AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE",
        "AD_EXCHANGE_LINE_ITEM_LEVEL_CLICKS"
      ],
      dimensionFilters: [
        {
          dimension: "CUSTOM_CRITERIA",
          operator: "CONTAINS",
          values: [`utm_campaign=${targetCampaignId}`]
        }
      ]
    }
  };

  console.log(`Querying GAM API for Campaign ${targetCampaignId} on ${date}...`);
  
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
    }),
  });
  
  const { access_token } = await tokenResponse.json();

  const url = `https://admanager.googleapis.com/v1/networks/${networkCode}/reports:run`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reportRequest),
  });

  const result = await response.json();
  
  if (result.error) {
    console.error("API Error:", JSON.stringify(result.error, null, 2));
    
    // If CUSTOM_CRITERIA fails, let's try just listing all dimensions for a small report to see what 'Channel' might be
    console.log("Attempting to identify 'Channel' dimension mapping...");
  } else {
    console.log("API Response:", JSON.stringify(result, null, 2));
  }
}

testGamChannelReport();
