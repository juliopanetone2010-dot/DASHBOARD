import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const siteId = "7185031b-788f-4134-b040-0255c4d6f461";

  try {
    const res = await fetch(supabaseUrl + "/functions/v1/gam-kv-diagnose", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + supabaseServiceKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        site_id: siteId,
        campaign_ids: ["23207554976", "23309079322", "22923001384"]
      })
    });

    const result = await res.json();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e);
  }
}

main();
