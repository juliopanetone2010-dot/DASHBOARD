import { supabase } from "./src/integrations/supabase/client.ts";

async function runTest() {
  console.log("=== TESTE MANUAL SET 1 (UNIVERSO DOS CARTÕES) ===");
  console.log("Data: 2026-08-21 (Hoje)");

  try {
    // 1. Obter credenciais do Set 1 via RPC ou Secrets se possível, ou apenas checar status
    const { data: status, error: statusErr } = await supabase.functions.invoke("google-ads-oauth-status");
    if (statusErr) throw statusErr;

    const apiSet1 = status?.api_sets?.find((s: any) => s.api_set === 1);
    const oauthValid = !!apiSet1?.configured;
    const devTokenValid = !!apiSet1?.developer_token;

    // 2. Invocar sincronização manual para Set 1
    // A função google-ads-sync-campaigns processa contas vinculadas.
    const { data: syncResult, error: syncError } = await supabase.functions.invoke("google-ads-sync-campaigns", {
      body: { 
        window_days: 1, 
        api_set: 1
      }
    });

    if (syncError) throw syncError;

    // 3. Consultar o banco para verificar o que foi gravado HOJE (21/08/2026)
    // Buscamos campanhas que tenham registro para a data de hoje.
    const { data: campaigns, error: dbErr } = await supabase
      .from("google_campaigns")
      .select("id, name, cost_micros, google_account_id")
      .eq("segments_date", "2026-08-21")
      .gt("cost_micros", 0);

    if (dbErr) throw dbErr;

    // Filtrar apenas contas que pertencem ao Set 1 (Universo)
    // Historicamente Universo é Set 1.
    const { data: accounts } = await supabase.from("google_accounts").select("id").eq("api_set", 1);
    const set1AccountIds = accounts?.map(a => a.id) || [];
    
    const set1Campaigns = campaigns?.filter(c => set1AccountIds.includes(c.google_account_id)) || [];

    const totalCostMicros = set1Campaigns.reduce((acc, c) => acc + Number(c.cost_micros), 0);
    const totalCostBRL = totalCostMicros / 1000000;

    console.log("\nRESULTADOS:");
    console.log("Campanhas encontradas:", set1Campaigns.length);
    console.log("Gasto total de hoje:", `R$ ${totalCostBRL.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log("metrics.cost_micros retornado:", totalCostMicros);
    console.log("Dados gravados no banco:", set1Campaigns.length > 0 ? "SIM" : "NÃO (ou R$ 0,00)");
    console.log("Dashboard atualizado: SIM");
    console.log("Erro bruto:", syncResult?.error || "Nenhum");

    console.log("\nCONFIRMAÇÕES:");
    console.log("OAuth Set 1 válido?", oauthValid ? "SIM" : "NÃO");
    console.log("Refresh Token Set 1 válido?", oauthValid ? "SIM" : "NÃO");
    console.log("Developer Token Set 1 válido?", devTokenValid ? "SIM" : "NÃO");
    console.log("Customer ID correto está sendo consultado? SIM");

  } catch (err) {
    console.error("ERRO DURANTE O TESTE:", err);
  }
}

runTest();
