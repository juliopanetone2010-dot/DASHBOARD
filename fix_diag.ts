import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const env = (k: string) => Deno.env.get(k) ?? "";

async function test(apiSet: number, cid: string) {
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

  // Use v18, but the correct URL structure is:
  // POST https://googleads.googleapis.com/v18/customers/{customer_id}/googleAds:search
  const cleanCid = cid.replace(/-/g, "");
  const url = `https://googleads.googleapis.com/v18/customers/${cleanCid}/googleAds:search`;
  
  console.log(`\n--- Testando Set ${apiSet} (${cid}) ---`);
  console.log(`URL: ${url}`);
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": devToken,
      "login-customer-id": cleanCid,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ 
      query: "SELECT campaign.id, campaign.name, metrics.cost_micros, segments.date FROM campaign WHERE segments.date DURING TODAY" 
    })
  });
  
  console.log(`Status: ${res.status}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    console.log("Response:", JSON.stringify(json, null, 2));
  } catch {
    console.log("HTML Start:", text.slice(0, 300));
  }
}

async function run() {
  await test(1, "4345381395");
  await test(2, "7197503782");
}

run();
