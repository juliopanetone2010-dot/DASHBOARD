import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";

interface ReportRow {
  date: string;
  campaignId: string | null;
  revenue: number;
  impressions: number;
  source: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { site_id, from, to } = body;
    
    if (!site_id || !from || !to) {
      return json({ error: "site_id, from, and to are required" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: site, error: siteErr } = await supabase
      .from("sites")
      .select("*")
      .eq("id", site_id)
      .single();

    if (siteErr || !site) return json({ error: "Site not found" }, 404);
    if (!site.network_code) return json({ error: "Site has no network_code" }, 400);

    const networkCode = site.network_code;
    const sa = JSON.parse(Deno.env.get("GAM_SERVICE_ACCOUNT_JSON")!);
    const accessToken = await getAccessToken(sa);

    const utmKeyId = await findCustomTargetingKeyId(networkCode, accessToken, "utm_campaign");
    console.log(`[gam-sync] Site: ${site.name} | Network: ${networkCode} | utm_campaign Key: ${utmKeyId}`);

    const rows = await runUnifiedReport(networkCode, accessToken, from, to, utmKeyId);
    console.log(`[gam-sync] Report complete. Rows: ${rows.length}`);

    const stats = await attributeAndStore(supabase, site, rows);

    return json({
      ok: true,
      site: site.name,
      period: { from, to },
      processed_rows: rows.length,
      stats
    });

  } catch (e) {
    console.error("[gam-sync-revenue] Error:", e);
    return json({ error: String(e) }, 500);
  }
});

async function runUnifiedReport(
  networkCode: string, 
  accessToken: string, 
  from: string, 
  to: string,
  utmKeyId: string | null
): Promise<ReportRow[]> {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);

  const reportDefinition: any = {
    reportType: "HISTORICAL",
    dimensions: ["DATE", "URL", "CUSTOM_DIMENSION"],
    metrics: ["AD_EXCHANGE_REVENUE", "AD_EXCHANGE_IMPRESSIONS"],
    customDimensionKeyIds: utmKeyId ? [utmKeyId] : [],
    dateRange: {
      fixed: {
        startDate: { year: fy, month: fm, day: fd },
        endDate: { year: ty, month: tm, day: td }
      }
    }
  };

  const createRes = await fetch(`${GAM_BASE}/networks/${networkCode}/reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ reportDefinition }),
  });
  if (!createRes.ok) throw new Error(`Report create failed: ${await createRes.text()}`);
  const { name: reportName } = await createRes.json();

  const runRes = await fetch(`${GAM_BASE}/${reportName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!runRes.ok) throw new Error(`Report run failed: ${await runRes.text()}`);
  const { name: operationName } = await runRes.json();

  let resultName = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const opRes = await fetch(`${GAM_BASE}/${operationName}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const opStatus = await opRes.json();
    if (opStatus.done) {
      if (opStatus.error) throw new Error(`Report job error: ${JSON.stringify(opStatus.error)}`);
      resultName = opStatus.response?.reportResult;
      break;
    }
  }

  if (!resultName) throw new Error("Report timeout");

  const allRows: ReportRow[] = [];
  let pageToken: string | undefined;
  const auditLogs: string[] = [];

  do {
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const rowsRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const rowsJson = await rowsRes.json();
    
    for (const r of (rowsJson.rows || [])) {
      const dims = r.dimensionValues || [];
      const dateRaw = String(dims[0]?.stringValue || dims[0]?.intValue || "");
      const date = dateRaw.length === 8 ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}` : dateRaw;
      
      const urlText = String(dims[1]?.stringValue || "");
      const customDim = String(dims[2]?.stringValue || "");
      
      // Try Custom Dimension first, then URL fallback
      let cid = extractCampaignId(customDim);
      if (!cid) cid = extractCampaignId(urlText);
      
      const metrics = r.metricValueGroups?.[0]?.primaryValues || [];
      const revenue = metrics[0]?.doubleValue !== undefined 
        ? Number(metrics[0].doubleValue) 
        : Number(metrics[0]?.intValue || 0) / 1_000_000;
      const impressions = Number(metrics[1]?.intValue || 0);

      if (revenue > 0 || impressions > 0) {
        // Log detailed attribution failure for diagnostic purposes
        if (!cid && revenue > 0.01) {
          console.log(`[audit-raw] Site: ${networkCode} | No CID in URL: ${urlText} or CD: ${customDim} | Rev: ${revenue}`);
          auditLogs.push(`[audit] No CID for: ${urlText.slice(0, 50)}...`);
        }
        allRows.push({
          date,
          campaignId: cid,
          revenue,
          impressions,
          source: cid ? "url_attributed" : "unattributed"
        });
      }
    }
    pageToken = rowsJson.nextPageToken;
  } while (pageToken);

  if (auditLogs.length > 0) {
    console.log(`[gam-sync] Audit summary for ${networkCode}: ${auditLogs.slice(0, 10).join(" | ")}`);
  }

  return allRows;
}

function extractCampaignId(text: string): string | null {
  if (!text) return null;
  // Decode URL if it looks encoded
  const decoded = text.includes('%') ? decodeURIComponent(text) : text;
  
  // Look for 8-12 digit IDs
  const match = decoded.match(/(?:campaignid|utm_campaign|placement|cid|wbraid|gbraid)[=:](\d{8,12})\b/) || 
                decoded.match(/\b(\d{10,12})\b/) ||
                decoded.match(/\b(\d{8,9})\b/);
  
  if (match) return match[1];

  // Fallback: If no direct ID found, try to map known profitable slugs to campaign IDs
  // This is a last-resort mapping based on campaign names provided in previous audits
  const slugMappings: Record<string, string> = {
    "rec-aprenda-a-monitorar-conversas-no-whatsapp": "23207554976", // MONITORAR WHAPP
    "rec-roblox-robux-skins-e-gift-cards": "23309079322",          // ROBLOX
    "como-ganhar-robux": "23309079322",
    "robux-gratis": "23309079322",
    "rec-como-conseguir-robux": "23309079322",
    "vagas-de-emprego": "22923001384"                             // EMPREGO
  };

  for (const [slug, id] of Object.entries(slugMappings)) {
    if (decoded.includes(slug)) return id;
  }

  return null;
}

async function attributeAndStore(supabase: any, site: any, rows: ReportRow[]) {
  const stats = { attributed: 0, total_revenue: 0, unattributed_revenue: 0 };
  
  const groups = new Map<string, { revenue: number, impressions: number }>();
  let dailyUnattributed = new Map<string, number>();

  for (const r of rows) {
    if (r.campaignId) {
      const key = `${r.date}|${r.campaignId}`;
      const cur = groups.get(key) || { revenue: 0, impressions: 0 };
      cur.revenue += r.revenue;
      cur.impressions += r.impressions;
      groups.set(key, cur);
      stats.total_revenue += r.revenue;
    } else {
      const currentRev = dailyUnattributed.get(r.date) || 0;
      dailyUnattributed.set(r.date, currentRev + r.revenue);
      stats.unattributed_revenue += r.revenue;
    }
  }

  const upserts = [];
  for (const [key, data] of groups.entries()) {
    const [date, cid] = key.split("|");
    upserts.push({
      site_id: site.id,
      user_id: site.user_id,
      date,
      campaign_id: cid,
      revenue_usd: data.revenue,
      impressions: data.impressions,
      utm_source: "google",
      attribution_status: "consolidated"
    });
    stats.attributed++;
  }

  // Handle unattributed revenue via aggregate rows
  for (const [date, revenue] of dailyUnattributed.entries()) {
    upserts.push({
      site_id: site.id,
      user_id: site.user_id,
      date,
      campaign_id: "__aggregate__",
      revenue_usd: revenue,
      impressions: 0,
      utm_source: "google",
      attribution_status: "consolidated"
    });
  }

  if (upserts.length > 0) {
    const { error } = await supabase
      .from("gam_campaign_source_revenue")
      .upsert(upserts, { onConflict: "user_id,site_id,campaign_id,date,utm_source" });
      
    if (error) throw new Error(`Upsert failed: ${error.message}`);
  }

  return stats;
}

async function findCustomTargetingKeyId(networkCode: string, accessToken: string, name: string): Promise<string | null> {
  const r = await fetch(`${GAM_BASE}/networks/${networkCode}/customTargetingKeys?pageSize=500`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!r.ok) return null;
  const data = await r.json();
  const key = (data.customTargetingKeys || []).find((k: any) => k.adTagName.toLowerCase() === name.toLowerCase());
  return key ? key.name.split("/").pop() : null;
}

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
  if (!r.ok) throw new Error(`Token error: ${JSON.stringify(j)}`);
  return j.access_token;
}

function json(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
