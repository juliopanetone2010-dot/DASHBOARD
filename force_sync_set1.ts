const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing environment variables VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY");
  process.exit(1);
}

async function forceSyncSet1() {
  console.log("=== FORÇANDO SINCRONIZAÇÃO SET 1 (UNIVERSO) ===");
  console.log("Data: 2026-08-21 (Hoje)");

  try {
    const syncRes = await fetch(`${SUPABASE_URL}/functions/v1/google-ads-sync-campaigns`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        date_preset: "TODAY", 
        api_set: 1
      })
    });
    const syncResult = await syncRes.json();
    console.log("Resposta da Sync:", JSON.stringify(syncResult, null, 2));

    // Validar gasto total atualizado na tabela daily_metrics
    const metricRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_metrics?date=eq.2026-08-21&select=spend`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    const metrics = await metricRes.json();
    
    const totalSpend = metrics.reduce((acc: number, m: any) => acc + Number(m.spend), 0);
    const totalCostMicros = totalSpend * 1000000;

    console.log("\nVALORES ATUALIZADOS:");
    console.log("Campanhas com gasto:", metrics.length);
    console.log("Novo Gasto Total:", `R$ ${totalSpend.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log("metrics.cost_micros:", totalCostMicros);

  } catch (err) {
    console.error("ERRO:", err);
  }
}

forceSyncSet1();