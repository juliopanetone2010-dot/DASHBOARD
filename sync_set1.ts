import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getCreds } from "./supabase/functions/_shared/google_api_set.ts";

const env = (k: string) => Deno.env.get(k) ?? "";

async function syncSet1() {
  console.log("--- TESTANDO SYNC UNIVERSO (SET 1) ---");
  const apiSet = 1;
  const targetDate = "2026-08-21";
  
  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceKey);

  const { clientId, clientSecret, devToken } = getCreds(apiSet);

  const { data: accounts } = await admin.from("google_accounts")
    .select("*")
    .eq("api_set", apiSet)
    .eq("is_mcc", false)
    .limit(1);

  if (!accounts || accounts.length === 0) return console.log("No Set 1 accounts found");

  const acc = accounts[0];
  console.log(`Testando Conta: ${acc.customer_id}`);

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
  if (!authRes.ok) return console.log(`Erro Auth: ${JSON.stringify(authJson)}`);
  
  const accessToken = authJson.access_token;
  const cleanCid = acc.customer_id.replace(/-/g, "");
  const query = `SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date = '${targetDate.replace(/-/g, "")}'`;
  
  const res = await fetch(`https://googleads.googleapis.com/v18/customers/${cleanCid}/googleAds:search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": devToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  });

  console.log(`Status: ${res.status}`);
  const text = await res.text();
  console.log(`Response: ${text.slice(0, 500)}`);
}

syncSet1();
