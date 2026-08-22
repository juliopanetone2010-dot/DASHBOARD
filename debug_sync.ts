import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testSync() {
  console.log("Starting debug sync for CID 23207554976 (Full Mode)...");
  
  const payload = {
    sync: true,
    datePreset: "TODAY",
    testMode: true,
    revenueOnly: false, // Forçar processamento completo
    siteMetricsOnly: false, // Permitir atribuição de campanhas
    userId: "68c92a7e-4b72-4d2c-8068-d0f507b9a5e2"
  };

  const { data, error } = await supabase.functions.invoke("gam-sync-revenue", {
    body: payload
  });

  if (error) {
    console.error("Invoke error:", error);
    return;
  }

  // Filtrar o log de debug para encontrar os termos de auditoria
  const auditLogs = data.debug?.filter((l: string) => 
    l.includes("AUDIT") || l.includes("SOAP_RAW") || l.includes("23207554976")
  ) || [];
  
  console.log("Audit Logs Found:", JSON.stringify(auditLogs, null, 2));
  console.log("Sync Response Mode:", data.summary?.[0]?.mode);
}

testSync();
