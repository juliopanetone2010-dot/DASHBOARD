import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const env = (k: string) => Deno.env.get(k) ?? "";

async function test(apiSet: number, cid: string, version: string) {
  const clientId = env(`GOOGLE_CLIENT_ID_${apiSet}`) || env("GOOGLE_CLIENT_ID");
  const clientSecret = env(`GOOGLE_CLIENT_SECRET_${apiSet}`) || env("GOOGLE_CLIENT_SECRET");
  const devToken = env(`GOOGLE_ADS_DEVELOPER_TOKEN_${apiSet}`) || env("GOOGLE_ADS_DEVELOPER_TOKEN");
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: acc } = await admin.from("google_accounts").select("*").eq("customer_id", cid).maybeSingle();
  if (!acc) return console.log(`Account ${cid} not found`);

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
  const accessToken = authJson.access_token;

  const url = `https://googleads.googleapis.com/${version}/customers/${cid}/googleAds:search`;
  console.log(`Testing ${url} (Set ${apiSet})...`);
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": devToken,
      "login-customer-id": cid,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query: "SELECT customer.id FROM customer LIMIT 1" })
  });
  
  console.log(`Status: ${res.status}`);
  const text = await res.text();
  try {
    console.log("JSON:", JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log("HTML Start:", text.slice(0, 200));
  }
}

async function run() {
  await test(1, "4345381395", "v18");
  await test(2, "7197503782", "v18");
}

run();
