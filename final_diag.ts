import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const env = (k: string) => Deno.env.get(k) ?? "";

async function run() {
  const apiSet = 2;
  const clientId = env(`GOOGLE_CLIENT_ID_${apiSet}`) || env("GOOGLE_CLIENT_ID");
  const clientSecret = env(`GOOGLE_CLIENT_SECRET_${apiSet}`) || env("GOOGLE_CLIENT_SECRET");
  const devToken = env(`GOOGLE_ADS_DEVELOPER_TOKEN_${apiSet}`);
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceKey);

  // MCC Jardim Astral
  const cid = "7197503782";
  const { data: mcc } = await admin.from("google_accounts").select("*").eq("customer_id", cid).maybeSingle();
  if (!mcc) return console.error("MCC not found");

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
  const accessToken = authJson.access_token;

  // Query sub-accounts (usando login-customer-id se for manager)
  // A conta 7197503782 é manager? Vamos testar com e sem o header.
  
  const query = "SELECT customer_client.id, customer_client.descriptive_name FROM customer_client WHERE customer_client.status = 'ENABLED'";
  
  console.log("--- Testando Query na MCC ---");
  const res = await fetch(`https://googleads.googleapis.com/v18/customers/${cid}/googleAds:search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": devToken,
      "login-customer-id": cid,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  });

  const resJson = await res.json();
  console.log("Status:", res.status);
  console.log("Response:", JSON.stringify(resJson, null, 2));
}

run();
