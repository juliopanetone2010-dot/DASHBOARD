import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";

// FORCED SOAP AUDIT V12 - BYPASSING REST LIMITS
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  
  try {
    const networkCode = "21683973686"; // Universo Dos Cartoes
    const sa = JSON.parse(Deno.env.get("GAM_SERVICE_ACCOUNT_JSON")!);
    const accessToken = await getAccessToken(sa);

    // 1) Query SOAP ReportService to see if these IDs exist for TODAY
    const targetIds = ["23207554976", "23309079322", "22923001384"];
    const now = new Date();
    const today = now.toISOString().split("T")[0].replace(/-/g, "");

    const soapBody = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v202405="https://www.google.com/apis/ads/publisher/v202405">
        <soapenv:Header>
          <v202405:RequestHeader>
            <v202405:networkCode>${networkCode}</v202405:networkCode>
            <v202405:applicationName>AdGeniusAudit</v202405:applicationName>
          </v202405:RequestHeader>
        </soapenv:Header>
        <soapenv:Body>
          <v202405:runReportJob>
            <v202405:reportJob>
              <v202405:reportQuery>
                <v202405:dimensions>DATE</v202405:dimensions>
                <v202405:dimensions>CUSTOM_DIMENSION</v202405:dimensions>
                <v202405:dimensions>AD_EXCHANGE_URL_CHANNEL_NAME</v202405:dimensions>
                <v202405:columns>AD_EXCHANGE_REVENUE</v202405:columns>
                <v202405:dateRangeType>TODAY</v202405:dateRangeType>
                <v202405:customDimensionKeyIds>13833777</v202405:customDimensionKeyIds> <!-- utm_campaign key ID from previous turn -->
              </v202405:reportQuery>
            </v202405:reportJob>
          </v202405:runReportJob>
        </soapenv:Body>
      </soapenv:Envelope>
    `;

    const soapR = await fetch(`https://ads.google.com/apis/ads/publisher/v202405/ReportService`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "text/xml",
        "SOAPAction": "runReportJob"
      },
      body: soapBody
    });

    const soapText = await soapR.text();
    const jobIdMatch = soapText.match(/<jobId>(\d+)<\/jobId>/);
    const jobId = jobIdMatch ? jobIdMatch[1] : null;

    return new Response(JSON.stringify({ 
      ok: true, 
      identity: "AUDIT_V12_SOAP",
      jobId: jobId,
      raw_response: soapText.substring(0, 1000)
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { 
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
});

async function getAccessToken(sa: any) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: any) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/\\n/g, "\n");
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey("pkcs8", buf.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sigB64}` }),
  });
  const j = await r.json();
  return j.access_token;
}
