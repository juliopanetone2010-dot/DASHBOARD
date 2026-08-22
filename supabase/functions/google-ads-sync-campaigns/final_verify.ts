import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function verifySet1() {
  console.log("--- VERIFICAÇÃO FINAL SET 1 (Universo) ---");
  
  const customerId = "4345381395";
  const { data: acc } = await supabase
    .from("google_accounts")
    .select("*")
    .eq("customer_id", customerId)
    .maybeSingle();

  if (!acc) {
    console.log("ERRO: MCC 4345381395 não encontrada.");
    return;
  }

  console.log(`MCC ${customerId} vinculada ao Set ${acc.api_set}.`);
  console.log(`Status atual no banco: ${acc.status}`);
  
  // Verificar se há gastos salvos hoje
  const today = new Date().toISOString().split('T')[0];
  const { data: metrics } = await supabase
    .from("daily_metrics")
    .select("spend")
    .eq("google_account_id", acc.id)
    .eq("date", today);

  const totalSpend = metrics?.reduce((sum, m) => sum + (Number(m.spend) || 0), 0) || 0;
  console.log(`Gasto total hoje (${today}) no banco: R$ ${totalSpend.toFixed(2)}`);
  
  if (totalSpend > 0) {
    console.log("VERIFICAÇÃO: Gastos carregados com sucesso.");
  } else {
    console.log("AVISO: Gastos zerados no banco para hoje (pode ser delay de sync).");
  }
}

await verifySet1();
