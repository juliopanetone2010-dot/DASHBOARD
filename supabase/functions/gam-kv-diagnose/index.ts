import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: site } = await admin.from("sites").select("id, name, network_code").eq("id", "7185031b-788f-4134-b040-0255c4d6f461").maybeSingle();
    
    if (!site?.network_code) return new Response(JSON.stringify({ error: "Site not found" }), { headers: corsHeaders });

    const sa = JSON.parse(Deno.env.get("GAM_SERVICE_ACCOUNT_JSON")!);
    const accessToken = await getAccessToken(sa);
    const networkCode = String(site.network_code);

    // 1) Keys
    const keys: any[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const url = new URL(`${GAM_BASE}/networks/${networkCode}/customTargetingKeys`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const j = await r.json();
      if (!r.ok) return new Response(JSON.stringify({ error: `keys failed`, detail: j }), { headers: corsHeaders });
      keys.push(...(j.customTargetingKeys ?? []));
      pageToken = j.nextPageToken;
      pages++;
    } while (pageToken && pages < 10);

    const wanted = keys
      .filter((k) => ["utm_source", "utm_campaign", "utm_placement"].includes(String(k.adTagName ?? "").toLowerCase()))
      .map((k) => ({
        adTagName: k.adTagName,
        id: String(k.customTargetingKeyId ?? String(k.name ?? "").split("/").pop()),
        type: k.type || k.customTargetingKeyType,
        reportable: k.reportableType,
        status: k.status
      }));

    // 2) Values for utm_campaign
    const campKey = wanted.find((k) => String(k.adTagName).toLowerCase() === "utm_campaign");
    let valuesSummary: any = null;
    const lookFor = ["23207554976", "23309079322", "22923001384"];

    if (campKey) {
      const vals: string[] = [];
      let vt: string | undefined;
      let vPages = 0;
      do {
        const vUrl = new URL(`${GAM_BASE}/networks/${networkCode}/customTargetingKeys/${campKey.id}/customTargetingValues`);
        vUrl.searchParams.set("pageSize", "1000");
        if (vt) vUrl.searchParams.set("pageToken", vt);
        const vr = await fetch(vUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        const vj = await vr.json();
        if (vr.ok) {
           for (const v of (vj.customTargetingValues ?? [])) {
             vals.push(String(v.adTagName ?? v.displayName ?? ""));
           }
        }
        vt = vj.nextPageToken;
        vPages++;
      } while (vt && vPages < 50);
      
      valuesSummary = {
        total_sample: vals.length,
        matched: lookFor.filter((c) => vals.includes(c)),
        missing: lookFor.filter((c) => !vals.includes(c)),
        sample: vals.slice(0, 50)
      };
    }

    return new Response(JSON.stringify({ ok: true, keys: wanted, values: valuesSummary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { headers: corsHeaders });
  }
});

async function getAccessToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
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
  return j.access_token as string;
}
