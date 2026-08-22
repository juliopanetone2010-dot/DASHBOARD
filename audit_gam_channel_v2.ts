import { createClient } from "https://esm.sh/@supabase/supabase-client@2.39.3";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function runAudit() {
  console.log("--- GAM API AUDIT: CHANNEL DIMENSION ---");
  
  // 1. Get credentials for Set 1
  const { data: secrets } = await supabase
    .from('secrets_manager')
    .select('*')
    .eq('api_set', 1)
    .single();

  if (!secrets) {
    console.error("No secrets found for Set 1");
    return;
  }

  const networkCode = "22953977775";
  const targetCampaignId = "23207554976";

  // Refresh Token
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: secrets.client_id,
      client_secret: secrets.client_secret,
      refresh_token: secrets.refresh_token,
    }),
  });
  
  const { access_token } = await tokenResponse.json();

  // Dimensões candidatas para "Channel" do UI
  // No GAM 360/REST, dimensions podem ser KEY_VALUES_NAME, CUSTOM_CRITERIA, ou AD_EXCHANGE_CHANNEL_NAME
  const dimensionsToTry = ["DATE", "AD_EXCHANGE_CHANNEL_NAME", "AD_EXCHANGE_CHANNEL_ID"];

  const reportRequest = {
    reportSpec: {
      dateRange: "CUSTOM",
      startDate: { year: 2026, month: 8, day: 21 },
      endDate: { year: 2026, month: 8, day: 21 },
      dimensions: dimensionsToTry,
      columns: [
        "AD_EXCHANGE_LINE_ITEM_LEVEL_IMPRESSIONS",
        "AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE",
        "AD_EXCHANGE_LINE_ITEM_LEVEL_MATCH_RATE"
      ],
      dimensionFilters: [
        {
          dimension: "AD_EXCHANGE_CHANNEL_NAME",
          operator: "CONTAINS",
          values: [targetCampaignId]
        }
      ]
    }
  };

  console.log(`Requesting report for Channel contains ${targetCampaignId}...`);
  
  const response = await fetch(`https://admanager.googleapis.com/v1/networks/${networkCode}/reports:run`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reportRequest),
  });

  const runResult = await response.json();
  console.log("Run Result:", JSON.stringify(runResult, null, 2));

  if (runResult.name) {
    // Wait for report to complete
    let status = "RUNNING";
    while (status === "RUNNING") {
      const checkResponse = await fetch(`https://admanager.googleapis.com/v1/${runResult.name}`, {
        headers: { "Authorization": `Bearer ${access_token}` }
      });
      const checkResult = await checkResponse.json();
      status = checkResult.state;
      console.log(`Report status: ${status}`);
      if (status === "COMPLETED") {
          const rowsResponse = await fetch(`https://admanager.googleapis.com/v1/${runResult.name}/rows`, {
              headers: { "Authorization": `Bearer ${access_token}` }
          });
          const rows = await rowsResponse.json();
          console.log("ROWS FOUND:", JSON.stringify(rows, null, 2));
      }
      if (status === "RUNNING") await new Promise(r => setTimeout(r, 2000));
    }
  }
}

runAudit();
