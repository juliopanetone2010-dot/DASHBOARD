import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

async function triggerSync() {
  console.log("Triggering manual GAM sync for today with deep audit...");
  
  const { data, error } = await fetch(`${supabaseUrl}/functions/v1/gam-sync-revenue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      date_preset: "TODAY",
      force_consolidated: true,
      debug: true,
      sync: true // Run synchronously to check output
    })
  }).then(r => r.json());

  if (error) {
    console.error("Sync error:", error);
  } else {
    console.log("Sync result:", JSON.stringify(data, null, 2));
  }
}

triggerSync();
