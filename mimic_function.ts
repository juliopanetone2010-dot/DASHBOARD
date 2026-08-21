import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getCreds } from "./supabase/functions/_shared/google_api_set.ts";

const env = (k: string) => Deno.env.get(k) ?? "";

async function testFunctionLogic() {
  const apiSet = 2;
  const rootCid = "7197503782";
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: root } = await admin.from("google_accounts").select("*").eq("customer_id", rootCid).maybeSingle();
  if (!root) return console.log("Root not found");

  const { clientId, clientSecret, devToken } = getCreds(apiSet);

  const authRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: root.refresh_token!,
      grant_type: "refresh_token"
    }),
  });
  const authJson = await authRes.json();
  const accessToken = authJson.access_token;

  console.log(`Auth Success. Access Token present: ${!!accessToken}`);

  const cq = "SELECT customer_client.id, customer_client.descriptive_name FROM customer_client WHERE customer_client.status = 'ENABLED'";
  const url = `https://googleads.googleapis.com/v18/customers/${root.customer_id.replace(/-/g, "")}/googleAds:search`;
  
  console.log(`Testing URL: ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": devToken,
      "login-customer-id": root.customer_id,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query: cq }),
  });

  console.log(`Status: ${res.status}`);
  const text = await res.text();
  console.log("Response Body (first 1000 chars):");
  console.log(text.slice(0, 1000));
}

testFunctionLogic();
