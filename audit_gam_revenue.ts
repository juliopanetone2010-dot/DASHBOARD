import { supabase } from "./src/integrations/supabase/client.ts";

async function runAudit() {
  const campaignIds = [
    "23309079322", "23021142139", "23450729920", "23036874694",
    "22923001384", "23026320710", "22922896278", "23446177394",
    "23736616702", "22974787890"
  ];

  console.log("Starting audit for 2026-08-20 and 2026-08-21...");

  for (const cid of campaignIds) {
    console.log(`\n--- Campaign ID: ${cid} ---`);
    
    // Check local database for current attribution
    const { data: dbRows, error: dbError } = await supabase
      .from('gam_campaign_source_revenue')
      .select('*')
      .eq('utm_campaign', cid)
      .in('date', ['2026-08-20', '2026-08-21'])
      .order('date', { ascending: false });

    if (dbError) console.error("DB Error:", dbError);
    
    const row21 = dbRows?.find(r => r.date === '2026-08-21');
    const row20 = dbRows?.find(r => r.date === '2026-08-20');

    console.log(`20/08 -> Revenue: $${row20?.revenue || 0} | Status: ${row20?.attribution_status || 'N/A'}`);
    console.log(`21/08 -> Revenue: $${row21?.revenue || 0} | Status: ${row21?.attribution_status || 'N/A'}`);
  }

  // Attempt manual sync via edge function call for 21/08
  console.log("\nAttempting targeted manual sync for 2026-08-21...");
  const { data: syncResult, error: syncError } = await supabase.functions.invoke('gam-sync-revenue', {
    body: { 
      date_preset: "CUSTOM",
      start_date: "2026-08-21",
      end_date: "2026-08-21",
      force_consolidated: true,
      debug_campaigns: campaignIds
    }
  });

  if (syncError) {
    console.error("Sync Error:", syncError);
  } else {
    console.log("Sync Response Summary:", JSON.stringify(syncResult, null, 2));
  }
}

runAudit().catch(console.error);
