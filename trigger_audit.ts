
async function testGamReport() {
    const networkCode = "22953977775";
    const targetCampaignId = "23207554976";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    console.log("--- GAM API AUDIT: TRIGGERING SYNC VIA EDGE FUNCTION ---");
    
    // Trigger the actual Edge Function with sync=true to force a manual audit/sync
    // Using the service role key to bypass auth if running locally or via CLI
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/gam-sync-revenue`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            sync: true,
            date_preset: "TODAY",
            mode: "revenue",
            force_consolidated: true,
            debug: true,
            audit_campaign_id: targetCampaignId
        })
    });
    
    const data = await res.json();
    console.log("Response:", JSON.stringify(data, null, 2));
}

testGamReport();
