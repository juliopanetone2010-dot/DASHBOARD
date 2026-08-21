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
  
  console.log(`--- Testando Conexão Google Ads ---`);
  
  // Lista de contas do Set 2 no banco
  const { data: accounts } = await admin.from("google_accounts").select("*").eq("api_set", apiSet);
  console.log(`Contas no Set 2: ${accounts?.length || 0}`);

  const mcc = accounts?.find(a => a.customer_id === "7197503782");
  if (!mcc) { console.error("MCC 719-750-3782 não encontrada."); return; }

  // Auth
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
  if (!authRes.ok) { console.error("Auth Error:", authJson); return; }
  const accessToken = authJson.access_token;

  // Testar QUERY simples na MCC
  const cid = mcc.customer_id.replace(/-/g, "");
  console.log(`Testando query na customer_id: ${cid}`);
  
  const res = await fetch(`https://googleads.googleapis.com/v18/customers/${cid}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": devToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: "SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1"
    })
  });

  const text = await res.text();
  console.log("Status:", res.status);
  try {
    const json = JSON.parse(text);
    console.log("JSON Response:", JSON.stringify(json, null, 2));
  } catch (e) {
    console.log("RAW Text:", text);
  }
}

runDiagnostic();
