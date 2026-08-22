import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testSync() {
  console.log("Starting debug sync (Consolidated 7-day deep audit)...");
  
  const payload = {
    sync: true,
    date_preset: "LAST_7_DAYS",
    test: true,
    include_full_reports: true,
    revenue_only: false,
    site_metrics_only: false,
    user_id: "68c92a7e-4b72-4d2c-8068-d0f507b9a5e2"
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
    l.includes("AUDIT") || 
    l.includes("MATCH_FOUND") ||
    l.includes("23207554976") || 
    l.includes("23309079322") ||
    l.includes("RAW_DATA")
  ) || [];
  
  console.log("Audit Logs Found:", JSON.stringify(auditLogs, null, 2));
  
  if (data.summary) {
    data.summary.forEach((s: any) => {
      console.log(`Summary: ${s.network_code} mode=${s.mode} rows=${s.rows_returned} rev=${s.total_revenue_native}`);
    });
  }
}

testSync();
