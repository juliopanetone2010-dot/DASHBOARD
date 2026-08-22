
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

async function checkAttribution() {
    console.log("--- Revenue Audit 20/08 (Baseline) ---");
    const { data: rev20 } = await supabase
        .from("gam_campaign_source_revenue")
        .select("campaign_id, revenue_usd")
        .eq("date", "2026-08-20")
        .eq("site_id", "28404d69-ba48-432c-ae7c-2610f79ab81f");
    console.log("20/08 Rows:", rev20?.length);
    console.log("20/08 Samples:", rev20?.slice(0, 3));

    console.log("\n--- Revenue Audit 22/08 (Post-Restore Today) ---");
    const { data: rev22 } = await supabase
        .from("gam_campaign_source_revenue")
        .select("campaign_id, revenue_usd")
        .eq("date", "2026-08-22")
        .eq("site_id", "28404d69-ba48-432c-ae7c-2610f79ab81f");
    console.log("22/08 Rows:", rev22?.length);
    console.log("22/08 Samples:", rev22?.slice(0, 3));
    
    const targetCids = ['23207554976', '23309079322', '22923001384'];
    const attributed = rev22?.filter(r => targetCids.includes(r.campaign_id));
    console.log("Attributed Target CIDs for 22/08:", attributed);
}

checkAttribution();
