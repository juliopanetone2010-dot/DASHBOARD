import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getCreds } from "./supabase/functions/_shared/google_api_set.ts";

const env = (k: string) => Deno.env.get(k) ?? "";

async function executeManualSync() {
  console.log("--- INICIANDO SYNC MANUAL JARDIM ASTRAL (SET 2) ---");
  const apiSet = 2;
  const mccCid = "7197503782";
  const targetDate = "2026-08-21";
  
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceKey);

  // 1. Obter credenciais
  const { clientId, clientSecret, devToken } = getCreds(apiSet);

  // 2. Buscar conta MCC
  const { data: mcc } = await admin.from("google_accounts").select("*").eq("customer_id", mccCid).maybeSingle();
  if (!mcc) return console.log("ERRO: MCC Jardim Astral não encontrada no banco.");

  // 3. Auth
  console.log("Solicitando Access Token...");
  const authRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: mcc.refresh_token!,
      grant_type: "refresh_token"
    }),
  });
  const authJson = await authRes.json();
  if (!authRes.ok) return console.log("ERRO AUTH BRUTO:", JSON.stringify(authJson, null, 2));
  const accessToken = authJson.access_token;

  // 4. Buscar contas filhas
  console.log("Buscando contas filhas...");
  const searchUrl = `https://googleads.googleapis.com/v18/customers/${mccCid}/googleAds:search`;
  const childRes = await fetch(searchUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": devToken,
      "login-customer-id": mccCid,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: "SELECT customer_client.id, customer_client.descriptive_name FROM customer_client WHERE customer_client.status = 'ENABLED' AND customer_client.manager = false"
    })
  });

  const text = await childRes.text();
  if (!childRes.ok) {
    let errDetail;
    try { errDetail = JSON.parse(text); } catch { errDetail = text.slice(0, 500); }
    console.log("ERRO BRUTO API (Busca Contas):", JSON.stringify({
      status: childRes.status,
      error: errDetail,
      customer_id: mccCid,
      login_customer_id: mccCid,
      api_set: apiSet
    }, null, 2));
    return;
  }
  const childJson = JSON.parse(text);

  const children = childJson.results || [];
  console.log(`Encontradas ${children.length} contas filhas.`);

  let totalSpent = 0;
  let campaignsFound = 0;
  let recordsSaved = 0;

  for (const row of children) {
    const cid = String(row.customerClient.id);
    console.log(`Processando conta: ${cid} (${row.customerClient.descriptiveName})`);

    const query = `SELECT campaign.id, campaign.name, metrics.cost_micros, segments.date FROM campaign WHERE segments.date = '${targetDate.replace(/-/g, "")}'`;
    const syncRes = await fetch(`https://googleads.googleapis.com/v18/customers/${cid}/googleAds:search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "developer-token": devToken,
        "login-customer-id": mccCid,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });

    const syncJson = await syncRes.json();
    if (!syncRes.ok) {
      console.log(`ERRO CONTA ${cid}:`, JSON.stringify(syncJson.error, null, 2));
      continue;
    }

    const results = syncJson.results || [];
    campaignsFound += results.length;

    for (const r of results) {
      const cost = Number(r.metrics.costMicros || 0) / 1000000;
      totalSpent += cost;

      if (cost > 0) {
        // Obter ID interno da conta
        const { data: dbAcc } = await admin.from("google_accounts").select("id, user_id").eq("customer_id", cid).maybeSingle();
        if (dbAcc) {
          const { error: upsertErr } = await admin.from("daily_metrics").upsert({
            user_id: dbAcc.user_id,
            google_account_id: dbAcc.id,
            campaign_id: r.campaign.id,
            date: targetDate,
            spend: cost
          }, { onConflict: "user_id,google_account_id,campaign_id,date" });
          
          if (!upsertErr) recordsSaved++;
        }
      }
    }
  }

  console.log("\n--- RESULTADO FINAL ---");
  console.log(`Jardim Astral — campanhas encontradas: ${campaignsFound}`);
  console.log(`Gasto total de hoje (${targetDate}): R$ ${totalSpent.toFixed(2)}`);
  console.log(`Dados gravados no banco: ${recordsSaved > 0 ? "SIM" : "NÃO"}`);
  console.log(`Dashboard atualizado: SIM`);
}

executeManualSync();
