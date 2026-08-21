import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const env = (k: string) => Deno.env.get(k) ?? "";

async function runDiagnostic() {
  const apiSet = 2;
  const clientId = env(`GOOGLE_CLIENT_ID_${apiSet}`) || env("GOOGLE_CLIENT_ID");
  const clientSecret = env(`GOOGLE_CLIENT_SECRET_${apiSet}`) || env("GOOGLE_CLIENT_SECRET");
  const devToken = env(`GOOGLE_ADS_DEVELOPER_TOKEN_${apiSet}`);
  
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceKey);
  
  console.log(`--- Iniciando Diagnóstico Set ${apiSet} ---`);
  console.log(`ClientId: ${clientId ? "OK" : "MISSING"}`);
  console.log(`DevToken: ${devToken ? "OK" : "MISSING"}`);

  // Pegar a MCC do Jardim Astral do banco
  const { data: mccAccount } = await admin.from("google_accounts")
    .select("*")
    .eq("customer_id", "7197503782")
    .eq("api_set", apiSet)
    .maybeSingle();

  if (!mccAccount) {
    console.error("ERRO: MCC account not found in DB for Set 2");
    return;
  }
  console.log(`MCC Account: ${mccAccount.customer_id} (${mccAccount.account_name})`);

  // 1. Obter Access Token
  console.log("Passo 1: Renovando Access Token...");
  const authUrl = "https://oauth2.googleapis.com/token";
  const authRes = await fetch(authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: mccAccount.refresh_token!,
      grant_type: "refresh_token"
    }),
  });
  
  const authJson = await authRes.json();
  if (!authRes.ok) {
    console.error("ERRO na Autenticação:", JSON.stringify(authJson, null, 2));
    return;
  }
  const accessToken = authJson.access_token;
  console.log("Access Token obtido com sucesso.");

  // 2. Tentar listar sub-contas
  console.log("Passo 2: Listando sub-contas (validando permissão da MCC)...");
  const url = `https://googleads.googleapis.com/v18/customers/${mccAccount.customer_id.replace(/-/g, "")}/googleAds:search`;
  console.log(`URL: ${url}`);
  const listRes = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": devToken,
      "login-customer-id": mccAccount.customer_id,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: "SELECT customer_client.id, customer_client.descriptive_name FROM customer_client WHERE customer_client.status = 'ENABLED'"
    }),
  });
  
  const text = await listRes.text();
  let listJson;
  try {
    listJson = JSON.parse(text);
  } catch (e) {
    console.error("ERRO: Resposta da API não é JSON (Step: list_accounts)");
    console.error("Status:", listRes.status);
    console.error("Content-Type:", listRes.headers.get("content-type"));
    console.error("Body:", text.slice(0, 500));
    return;
  }
  
  if (!listRes.ok) {
    console.error("ERRO ao listar contas:", JSON.stringify(listJson, null, 2));
    return;
  }
  const children = listJson.results ?? [];
  console.log(`Sucesso: ${children.length} sub-contas encontradas.`);

  // 3. Buscar gastos de HOJE para a primeira conta filha com spend
  console.log("Passo 3: Buscando gastos de HOJE...");
  for (const child of children) {
    const childCid = child.customerClient.id;
    if (childCid === mccAccount.customer_id) continue;
    
    console.log(`Consultando conta filha: ${childCid} (${child.customerClient.descriptiveName})...`);
    const query = `
      SELECT 
        campaign.id, 
        campaign.name, 
        metrics.cost_micros, 
        segments.date 
      FROM campaign 
      WHERE segments.date DURING TODAY
    `;
    
    const camRes = await fetch(`https://googleads.googleapis.com/v18/customers/${childCid}/googleAds:search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": devToken,
        "login-customer-id": mccAccount.customer_id,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query }),
    });
    
    const camJson = await camRes.json();
    if (!camRes.ok) {
      console.error(`ERRO na conta ${childCid}:`, JSON.stringify(camJson, null, 2));
    } else {
      const rows = camJson.results ?? [];
      const totalCost = rows.reduce((acc, r) => acc + Number(r.metrics.costMicros), 0) / 1000000;
      console.log(`SUCESSO na conta ${childCid}: ${rows.length} campanhas com spend de R$ ${totalCost.toFixed(2)} hoje.`);
      if (rows.length > 0) {
          console.log("Exemplo de campanha:", JSON.stringify(rows[0], null, 2));
      }
    }
  }
}

runDiagnostic();
