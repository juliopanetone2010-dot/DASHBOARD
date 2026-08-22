import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  
  try {
    const body = await req.json().catch(() => ({} as any));
    const siteId = String(body?.site_id ?? "");
    const lookFor: string[] = Array.isArray(body?.campaign_ids) ? body.campaign_ids.map(String) : [];

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
    const isServiceKey = token === serviceRoleKey && serviceRoleKey.length > 0;

    if (!isServiceKey) {
      return new Response(JSON.stringify({ error: "Unauthorized - Service Role Only for Audit" }), { 
        status: 401, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceRoleKey);
    const { data: site } = await admin.from("sites").select("id, name, network_code, user_id").eq("id", siteId).maybeSingle();
    
    if (!site?.network_code) {
      return new Response(JSON.stringify({ error: "Site not found", siteId }), { 
        status: 404, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const sa = JSON.parse(Deno.env.get("GAM_SERVICE_ACCOUNT_JSON")!);
    const accessToken = await getAccessToken(sa);
    const networkCode = String(site.network_code);

    // 1) Keys
    const keys: any[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${GAM_BASE}/networks/${networkCode}/customTargetingKeys`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const j = await r.json();
      if (!r.ok) return json({ error: `customTargetingKeys ${r.status}`, detail: j });
      keys.push(...(j.customTargetingKeys ?? []));
      pageToken = j.nextPageToken;
    } while (pageToken);

    const wanted = keys
      .filter((k) => ["utm_source", "utm_campaign", "utm_placement"].includes(String(k.adTagName ?? "").toLowerCase()))
      .map((k) => ({
        adTagName: k.adTagName,
        id: String(k.customTargetingKeyId ?? String(k.name ?? "").split("/").pop()),
        type: k.type ?? k.customTargetingKeyType ?? null,
        status: k.status ?? null,
        reportableType: k.reportableType ?? null,
      }));

    // 2) Values for utm_campaign
    const campKey = wanted.find((k) => String(k.adTagName).toLowerCase() === "utm_campaign");
    let valuesSummary: any = null;
    if (campKey) {
      const values: string[] = [];
      let vt: string | undefined;
      let pages = 0;
      do {
        const url = new URL(`${GAM_BASE}/networks/${networkCode}/customTargetingKeys/${campKey.id}/customTargetingValues`);
        url.searchParams.set("pageSize", "1000");
        if (vt) url.searchParams.set("pageToken", vt);
        const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const j = await r.json();
        if (!r.ok) { valuesSummary = { error: `values ${r.status}`, detail: j }; break; }
        for (const v of (j.customTargetingValues ?? [])) values.push(String(v.adTagName ?? v.displayName ?? ""));
        vt = j.nextPageToken;
        pages++;
      } while (vt && pages < 50); // Increased page limit for deeper audit
      
      valuesSummary = {
        total_found_in_pages: values.length,
        matched: lookFor.filter((c) => values.includes(c)),
        missing: lookFor.filter((c) => !values.includes(c)),
        sample_recent: values.slice(-20),
      };
    }

    return new Response(JSON.stringify({ 
      ok: true, 
      network_code: networkCode, 
      site: site.name, 
      keys: wanted, 
      utm_campaign_values: valuesSummary 
    }), { 
      status: 200, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
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
  if (!r.ok) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
  return j.access_token as string;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
