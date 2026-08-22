import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

async function triggerSync() {
  // Get an admin user ID to impersonate if needed, but the function should accept service role
  console.log("Triggering manual GAM sync for today with deep audit using service role...");
  
  const response = await fetch(`${supabaseUrl}/functions/v1/gam-sync-revenue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      date_preset: "TODAY",
      force_consolidated: true,
      debug: true,
      sync: true
    })
  });

  const text = await response.text();
  console.log("Status:", response.status);
  console.log("Body:", text);
}

triggerSync();
