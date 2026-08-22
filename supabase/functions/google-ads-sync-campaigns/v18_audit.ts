import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function checkV18() {
  console.log("--- AUDIT: Buscando referências v18 ---");
  
  // 1. Verificar Edge Functions que podem estar usando a URL hardcoded
  const functions = [
    "google-ads-list-accounts",
    "google-ads-sync-campaigns",
    "google-ads-sync-placements",
    "google-ads-mutate",
    "google-ads-audit-status",
    "google-ads-sync-countries",
    "google-ads-sync-creatives"
  ];

  for (const fn of functions) {
    try {
      const path = `supabase/functions/${fn}/index.ts`;
      const content = await Deno.readTextFile(path);
      const v18Matches = content.match(/v18/g);
      const v24Matches = content.match(/v24/g);
      console.log(`Função: ${fn} | v18: ${v18Matches?.length || 0} | v24: ${v24Matches?.length || 0}`);
      
      if (content.includes("googleads.googleapis.com/v18")) {
         console.log(`  [CRÍTICO] URL v18 encontrada em ${path}`);
      }
    } catch (e) {
      console.log(`Função ${fn} não encontrada localmente ou erro ao ler.`);
    }
  }

  // 2. Tentar identificar a chamada específica da MCC 4345381395
  console.log("\n--- TESTE DE CONEXÃO: MCC 4345381395 (Set 1) ---");
  const { data: accounts } = await supabase
    .from("google_accounts")
    .select("*")
    .eq("customer_id", "4345381395")
    .maybeSingle();

  if (!accounts) {
    console.log("MCC 4345381395 não encontrada no banco.");
    return;
  }

  console.log(`MCC encontrada. Api Set: ${accounts.api_set}. Status: ${accounts.status}`);
}

await checkV18();
