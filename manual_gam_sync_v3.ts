import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

async function triggerSync() {
  // Find a real user to impersonate
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1);
  if (!profiles || profiles.length === 0) {
    console.error("No profiles found to impersonate");
    return;
  }
  const userId = profiles[0].id;
  console.log(`Impersonating user: ${userId}`);

  const response = await fetch(`${supabaseUrl}/functions/v1/gam-sync-revenue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      user_id: userId,
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
