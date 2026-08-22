import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const networkCode = "22953977775";
const targetCampaignId = "23207554976";
const date = "2026-08-21";

async function runAudit() {
  console.log("--- GAM API AUDIT: CHANNEL DIMENSION REPRODUCTION ---");
  
  // Read from file directly to avoid env var issues
  const saJsonRaw = Deno.readTextFileSync(".env")
    .split("\n")
    .find(line => line.startsWith("GAM_SERVICE_ACCOUNT_JSON="))
    ?.split("=")[1];
    
  if (!saJsonRaw) throw new Error("GAM_SERVICE_ACCOUNT_JSON not found in .env");
  
  // Handle quotes
  let cleaned = saJsonRaw.trim();
  if (cleaned.startsWith('"')) cleaned = cleaned.substring(1);
  if (cleaned.endsWith('"')) cleaned = cleaned.substring(0, cleaned.length - 1);
  // Unescape \n
  cleaned = cleaned.replace(/\\n/g, "\n");
  
  const sa = JSON.parse(cleaned);

  const accessToken = await getAccessToken(sa);
  console.log("Got Access Token");

  // We will try to fetch a report using AD_EXCHANGE_CHANNEL_NAME filtered by the campaign ID.
  const reportRequest = {
    reportSpec: {
      dateRange: "CUSTOM",
      startDate: { year: 2026, month: 8, day: 21 },
      endDate: { year: 2026, month: 8, day: 21 },
      dimensions: ["DATE", "AD_EXCHANGE_CHANNEL_NAME"],
      columns: [
        "AD_EXCHANGE_IMPRESSIONS",
        "AD_EXCHANGE_REVENUE",
      ],
      dimensionFilters: [
        {
          dimension: "AD_EXCHANGE_CHANNEL_NAME",
          operator: "CONTAINS",
          values: [targetCampaignId]
        }
      ]
    }
  };

  console.log(`Running report for ${targetCampaignId} on ${date}...`);
  
  const createRes = await fetch(`https://admanager.googleapis.com/v1/networks/${networkCode}/reports`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(reportRequest),
  });
  
  const createJson = await createRes.json();
  if (!createRes.ok) {
    console.error("Report creation failed:", JSON.stringify(createJson, null, 2));
    return;
  }

  const reportName = createJson.name;
  console.log(`Report created: ${reportName}`);

  const runRes = await fetch(`https://admanager.googleapis.com/v1/${reportName}:run`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  const runJson = await runRes.json();
  const opName = runJson.name;

  let done = false;
  let resultName = "";
  for(let i=0; i<30; i++) {
    console.log("Polling report status...");
    const opRes = await fetch(`https://admanager.googleapis.com/v1/${opName}`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const opJson = await opRes.json();
    if (opJson.done) {
      done = true;
      resultName = opJson.response.name;
      break;
    } else {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if(!done) throw new Error("Report timeout");

  console.log(`Fetching rows from ${resultName}...`);
  const rowsRes = await fetch(`https://admanager.googleapis.com/v1/${resultName}:fetchRows`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  const rowsJson = await rowsRes.json();
  
  console.log("FINAL RESULT:");
  console.log(JSON.stringify(rowsJson, null, 2));
  
  if (rowsJson.rows && rowsJson.rows.length > 0) {
      const row = rowsJson.rows[0];
      const channel = row.dimensionValues[1].stringValue;
      const impressions = row.metricValueGroups[0].primaryValues[0].intValue;
      const revenueMicros = row.metricValueGroups[0].primaryValues[1].intValue;
      const revenue = Number(revenueMicros) / 1000000;
      
      console.log("\n--- AUDIT SUMMARY ---");
      console.log(`Dimensão API correspondente a Channel: AD_EXCHANGE_CHANNEL_NAME`);
      console.log(`Linhas retornadas: ${rowsJson.rows.length}`);
      console.log(`Channel encontrado: ${channel}`);
      console.log(`Impressões: ${impressions}`);
      console.log(`Receita retornada: R$ ${revenue.toFixed(2)}`);
      console.log(`Valor do GAM manual: R$ 1.474,31`);
      console.log(`API bateu com o GAM: ${Math.abs(revenue - 1474.31) < 10 ? "SIM" : "NÃO"}`);
  } else {
      console.log("\nNenhuma linha retornada.");
  }
}

async function getAccessToken(sa: any) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/admanager",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const header = { alg: "RS256", typ: "JWT" };
  const enc = (o: any) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${enc(header)}.${enc(claim)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importKey(sa.private_key), new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sigB64}` }),
  });
  const data = await res.json();
  if(!res.ok) throw new Error("Token failed: " + JSON.stringify(data));
  return data.access_token;
}

async function importKey(pem: string) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return await crypto.subtle.importKey("pkcs8", buf.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

runAudit();
