import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("VITE_SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

async function triggerSync() {
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1);
  const userId = profiles[0].id;
  
  // Try sending user_id in body AND use service role in header
  // Let's check if the service role key matches what the function expects
  console.log(`Triggering for user: ${userId}`);

  const response = await fetch(`${supabaseUrl}/functions/v1/gam-sync-revenue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      user_id: userId,
      date_preset: "TODAY",
      sync: true,
      debug: true
    })
  });

  const text = await response.text();
  console.log("Status:", response.status);
  console.log("Body:", text);
}

triggerSync();
