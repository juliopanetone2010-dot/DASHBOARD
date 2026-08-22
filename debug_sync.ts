import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testSync() {
  console.log("Starting debug sync for CID 23207554976...");
  
  const payload = {
    sync: true,
    datePreset: "TODAY",
    testMode: true,
    // Site: Universo Dos Cartões (ajustar ID se necessário, mas o sync global deve pegar)
    userId: "68c92a7e-4b72-4d2c-8068-d0f507b9a5e2" // Rilker
  };

  const { data, error } = await supabase.functions.invoke("gam-sync-revenue", {
    body: payload
  });

  if (error) {
    console.error("Invoke error:", error);
    return;
  }

  console.log("Sync Response:", JSON.stringify(data, null, 2));
}

testSync();
