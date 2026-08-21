const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

async function forceSyncSet1() {
  console.log("=== FORÇANDO SINCRONIZAÇÃO SET 1 (UNIVERSO) ===");
  console.log("Data: 2026-08-21 (Hoje)");

  try {
    // 1. Invocação de sincronização profunda para Set 1
    const syncRes = await fetch(`${SUPABASE_URL}/functions/v1/google-ads-sync-campaigns`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        date_preset: "TODAY", 
        api_set: 1,
        force_refresh: true 
      })
    });
    const syncResult = await syncRes.json();
    console.log("Resposta da Sync:", JSON.stringify(syncResult, null, 2));

    // 2. Verificar novos valores no banco
    const camRes = await fetch(`${SUPABASE_URL}/rest/v1/google_campaigns?segments_date=eq.2026-08-21&cost_micros=gt.0&select=id,name,cost_micros`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    const campaigns = await camRes.json();
    
    const totalCostMicros = campaigns.reduce((acc: number, c: any) => acc + Number(c.cost_micros), 0);
    const totalCostBRL = totalCostMicros / 1000000;

    console.log("\nVALORES ATUALIZADOS:");
    console.log("Campanhas com gasto:", campaigns.length);
    console.log("Novo Gasto Total:", `R$ ${totalCostBRL.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log("metrics.cost_micros:", totalCostMicros);

  } catch (err) {
    console.error("ERRO:", err);
  }
}

forceSyncSet1();
