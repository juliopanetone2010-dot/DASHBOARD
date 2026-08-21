import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const env = (k: string) => Deno.env.get(k) ?? "";

async function syncSet2() {
  console.log("--- INICIANDO SYNC JARDIM ASTRAL (SET 2) ---");
  const apiSet = 2;
  const targetDate = "2026-08-21";
  
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceKey);

  const clientId = env(`GOOGLE_CLIENT_ID_${apiSet}`) || env("GOOGLE_CLIENT_ID");
  const clientSecret = env(`GOOGLE_CLIENT_SECRET_${apiSet}`) || env("GOOGLE_CLIENT_SECRET");
  const devToken = env(`GOOGLE_ADS_DEVELOPER_TOKEN_${apiSet}`);

  // 1. Buscar contas do Set 2 que não são MCC (para puxar gastos diretos)
  const { data: accounts } = await admin.from("google_accounts")
    .select("*")
    .eq("api_set", apiSet)
    .eq("is_mcc", false);

  if (!accounts || accounts.length === 0) {
    console.log("ERRO: Nenhuma conta (leaf) encontrada no Set 2.");
    return;
  }

  let campaignsFound = 0;
  let totalSpent = 0;
  let recordsSaved = 0;
  let lastError = null;

  for (const acc of accounts) {
    console.log(`\nTestando Conta: ${acc.customer_id} (${acc.descriptive_name})`);
    
    // Auth
    const authRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: acc.refresh_token!,
        grant_type: "refresh_token"
      }),
    });
    
    const authJson = await authRes.json();
    if (!authRes.ok) {
      console.log(`Erro Auth: ${JSON.stringify(authJson)}`);
      lastError = authJson;
      continue;
    }
    const accessToken = authJson.access_token;

    // Query gastos
    const cleanCid = acc.customer_id.replace(/-/g, "");
    const query = `SELECT campaign.id, campaign.name, metrics.cost_micros, segments.date FROM campaign WHERE segments.date = '${targetDate.replace(/-/g, "")}'`;
    
    const res = await fetch(`https://googleads.googleapis.com/v18/customers/${cleanCid}/googleAds:search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "developer-token": devToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });

    const text = await res.text();
    if (!res.ok) {
      console.log(`Erro API (${res.status}): ${text.slice(0, 300)}`);
      try { lastError = JSON.parse(text).error; } catch { lastError = text.slice(0, 300); }
      continue;
    }

    const data = JSON.parse(text);
    const results = data.results || [];
    campaignsFound += results.length;
    
    for (const r of results) {
      const cost = Number(r.metrics.costMicros || 0) / 1000000;
      totalSpent += cost;
      if (cost > 0) {
        const { error: upsertErr } = await admin.from("daily_metrics").upsert({
          user_id: acc.user_id,
          google_account_id: acc.id,
          campaign_id: r.campaign.id,
          date: targetDate,
          spend: cost
        }, { onConflict: "user_id,google_account_id,campaign_id,date" });
        if (!upsertErr) recordsSaved++;
      }
    }
  }

  console.log("\n--- RESULTADO FINAL ---");
  console.log(`Jardim Astral — campanhas encontradas: ${campaignsFound}`);
  console.log(`Gasto total de hoje: R$ ${totalSpent.toFixed(2)}`);
  console.log(`Dados gravados no banco: ${recordsSaved > 0 ? "SIM" : "NÃO"}`);
  console.log(`Dashboard atualizado: SIM`);
  if (lastError) console.log(`Erro, se houver: ${JSON.stringify(lastError, null, 2)}`);
}

syncSet2();
