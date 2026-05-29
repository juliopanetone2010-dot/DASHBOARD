// gam-sync-push-retention
// Engine isolada para Retenção/Push: puxa do GAM linhas (DATE, URL_NAME, CUSTOM_CRITERIA),
// filtra ESTRITAMENTE utm_source=push, normaliza URL e grava em push_retention_revenue.
// Linhas agregadas (sem URL) vão pra unattributed_push_revenue.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { normalizePushUrl, isAggregateUrl, parseCustomCriteria } from "../_shared/normalize_url.ts";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";

interface ReportRow {
  date: string | null;
  url: string;
  rawKv: string;
  impressions: number;
  revenue: number;
}

interface DebugReport {
  totalRowsFromGam: number;
  matchedPush: number;
  ignoredNoPush: number;
  aggregateRows: number;
  duplicates: number;
  ecpmAnomalies: number;
  sampleIgnored: string[];
  sampleMatched: string[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" }, 401);

    const body = await req.json().catch(() => ({} as any));
    const siteId = String(body?.site_id ?? "");
    const from = String(body?.from ?? "");
    const to = String(body?.to ?? "");
    if (!siteId) return json({ error: "site_id obrigatório" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return json({ error: "from/to obrigatórios (yyyy-mm-dd)" }, 400);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const user = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: u, error: uErr } = await user.auth.getUser();
    if (uErr || !u?.user) return json({ error: "Sessão inválida" }, 401);
    const userId = u.user.id;

    // RBAC: pode acessar este site?
    const { data: canAccess } = await admin.rpc("can_access_site", { _uid: userId, _site_id: siteId });
    if (!canAccess) return json({ error: "Sem acesso a este site" }, 403);

    // Carrega site
    const { data: site, error: sErr } = await admin
      .from("sites")
      .select("id, user_id, network_code, name, domain")
      .eq("id", siteId)
      .maybeSingle();
    if (sErr || !site) return json({ error: "Site não encontrado" }, 404);
    if (!site.network_code) return json({ error: "Site sem network_code do GAM" }, 400);

    // Service account
    const saJsonRaw = Deno.env.get("GAM_SERVICE_ACCOUNT_JSON");
    if (!saJsonRaw) return json({ error: "GAM_SERVICE_ACCOUNT_JSON não configurada" }, 500);
    const sa = JSON.parse(saJsonRaw);
    const accessToken = await getAccessToken(sa);

    // Roda report (DATE, URL_NAME, CUSTOM_CRITERIA)
    const rows = await runReport({
      networkCode: site.network_code,
      accessToken,
      from,
      to,
    });

    const debug: DebugReport = {
      totalRowsFromGam: rows.length,
      matchedPush: 0,
      ignoredNoPush: 0,
      aggregateRows: 0,
      duplicates: 0,
      ecpmAnomalies: 0,
      sampleIgnored: [],
      sampleMatched: [],
    };

    // Bucketiza por (date, normalized_url)
    type Bucket = {
      date: string;
      url: string;
      normalized_url: string;
      revenue_usd: number;
      impressions: number;
      raw_gam_row: any;
    };
    const buckets = new Map<string, Bucket>();
    const unattribBuckets = new Map<string, { date: string; revenue_usd: number; impressions: number; reason: string; raw: any }>();
    const seenKeys = new Set<string>();

    for (const r of rows) {
      if (!r.date) continue;
      const kv = parseCustomCriteria(r.rawKv);
      const utmSource = (kv.utm_source ?? "").toLowerCase().trim();

      // FILTRO ESTRITO
      if (utmSource !== "push") {
        debug.ignoredNoPush++;
        if (debug.sampleIgnored.length < 5) {
          debug.sampleIgnored.push(`utm=${utmSource || "(none)"}|url=${r.url.slice(0, 80)}|rev=${r.revenue.toFixed(4)}`);
        }
        continue;
      }

      // Aggregate?
      if (isAggregateUrl(r.url)) {
        debug.aggregateRows++;
        const k = `${r.date}|aggregate`;
        const cur = unattribBuckets.get(k) ?? { date: r.date, revenue_usd: 0, impressions: 0, reason: "aggregate", raw: r };
        cur.revenue_usd += r.revenue;
        cur.impressions += r.impressions;
        unattribBuckets.set(k, cur);
        continue;
      }

      const normalized = normalizePushUrl(r.url);
      if (!normalized) {
        debug.aggregateRows++;
        continue;
      }
      const key = `${r.date}|${normalized}`;
      if (seenKeys.has(key)) debug.duplicates++;
      seenKeys.add(key);

      const cur = buckets.get(key) ?? {
        date: r.date, url: r.url, normalized_url: normalized,
        revenue_usd: 0, impressions: 0, raw_gam_row: r,
      };
      cur.revenue_usd += r.revenue;
      cur.impressions += r.impressions;
      buckets.set(key, cur);
      debug.matchedPush++;
      if (debug.sampleMatched.length < 5) {
        debug.sampleMatched.push(`${r.date}|${normalized.slice(0, 80)}|rev=${r.revenue.toFixed(4)}|imp=${r.impressions}`);
      }
    }

    // Limpa período antes do upsert (evita lixo de runs antigas)
    await admin.from("push_retention_revenue")
      .delete()
      .eq("site_id", siteId)
      .gte("date", from)
      .lte("date", to);
    await admin.from("unattributed_push_revenue")
      .delete()
      .eq("site_id", siteId)
      .gte("date", from)
      .lte("date", to);

    // Upsert
    const inserts = [...buckets.values()].map((b) => {
      const ecpm = b.impressions > 0 ? (b.revenue_usd / b.impressions) * 1000 : 0;
      if (ecpm > 1000 || (b.revenue_usd > 0 && ecpm < 0.01)) debug.ecpmAnomalies++;
      return {
        user_id: site.user_id,
        site_id: siteId,
        date: b.date,
        url: b.url,
        normalized_url: b.normalized_url,
        utm_source: "push",
        revenue_usd: b.revenue_usd,
        impressions: b.impressions,
        ecpm,
        source: "gam-sync-push-retention",
        raw_gam_row: b.raw_gam_row,
      };
    });

    if (inserts.length) {
      // chunk inserts
      const CHUNK = 500;
      for (let i = 0; i < inserts.length; i += CHUNK) {
        const { error } = await admin.from("push_retention_revenue").insert(inserts.slice(i, i + CHUNK));
        if (error) throw new Error(`insert push_retention_revenue: ${error.message}`);
      }
    }

    const unattribInserts = [...unattribBuckets.values()].map((b) => ({
      user_id: site.user_id,
      site_id: siteId,
      date: b.date,
      revenue_usd: b.revenue_usd,
      impressions: b.impressions,
      reason: b.reason,
      raw_gam_row: b.raw,
    }));
    if (unattribInserts.length) {
      const { error } = await admin.from("unattributed_push_revenue").insert(unattribInserts);
      if (error) throw new Error(`insert unattributed_push_revenue: ${error.message}`);
    }

    return json({
      ok: true,
      site_id: siteId,
      period: { from, to },
      inserted: inserts.length,
      unattributed: unattribInserts.length,
      debug,
    });
  } catch (e) {
    console.error("[gam-sync-push-retention] error", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ============ GAM Report ============
async function runReport(args: { networkCode: string; accessToken: string; from: string; to: string }): Promise<ReportRow[]> {
  const { networkCode, accessToken, from, to } = args;
  const tag = `${networkCode}/PUSH`;

  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  // GAM API v1 não aceita URL_NAME + CUSTOM_CRITERIA juntos.
  // URL_NAME já inclui a URL completa com query string, então parseamos utm_source da própria URL.
  const reportDefinition = {
    reportType: "HISTORICAL",
    dimensions: ["DATE", "URL_NAME"],
    metrics: ["AD_SERVER_IMPRESSIONS", "AD_SERVER_REVENUE", "AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE", "ADSENSE_IMPRESSIONS", "ADSENSE_REVENUE"],
    dateRange: {
      fixed: {
        startDate: { year: fy, month: fm, day: fd },
        endDate: { year: ty, month: tm, day: td },
      },
    },
  };

  const createRes = await fetch(`${GAM_BASE}/networks/${networkCode}/reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ visibility: "DRAFT", reportDefinition }),
  });
  const createText = await createRes.text();
  if (!createRes.ok) throw new Error(`[${tag}] create failed (${createRes.status}): ${createText.slice(0, 400)}`);
  const createJson = JSON.parse(createText);
  const reportName: string = createJson.name;

  const runRes = await fetch(`${GAM_BASE}/${reportName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const runJson = JSON.parse(await runRes.text());
  if (!runRes.ok) throw new Error(`[${tag}] run failed: ${JSON.stringify(runJson)}`);
  const opName: string = runJson.name;

  let resultName: string | null = null;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const opRes = await fetch(`${GAM_BASE}/${opName}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const opJson = JSON.parse(await opRes.text());
    if (opJson.done) {
      if (opJson.error) throw new Error(`[${tag}] op error: ${JSON.stringify(opJson.error)}`);
      resultName = opJson.response?.reportResult?.name ?? opJson.response?.reportResult ?? opJson.response?.name;
      if (!resultName) throw new Error(`[${tag}] no reportResult`);
      break;
    }
  }
  if (!resultName) throw new Error(`[${tag}] report timeout`);

  const all: ReportRow[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    const rowsRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const rowsJson = JSON.parse(await rowsRes.text());
    if (!rowsRes.ok) throw new Error(`[${tag}] fetchRows failed: ${JSON.stringify(rowsJson)}`);

    for (const r of (rowsJson.rows ?? [])) {
      const dims = r.dimensionValues ?? [];
      const date = parseGamDate(dims[0]);
      const urlName = String(dims[1]?.stringValue ?? "");
      const kv = String(dims[2]?.stringValue ?? "");
      const m = r.metricValueGroups?.[0]?.primaryValues ?? [];
      const num = (v: any) => Number(v?.intValue ?? v?.doubleValue ?? 0);
      const numRev = (v: any) => {
        if (!v) return 0;
        if (v.intValue != null) return Number(v.intValue) / 1_000_000;
        if (v.doubleValue != null) return Number(v.doubleValue);
        return 0;
      };
      const impressions = num(m[0]) + num(m[2]) + num(m[4]);
      const revenue = numRev(m[1]) + numRev(m[3]) + numRev(m[5]);
      all.push({ date, url: urlName, rawKv: kv, impressions, revenue });
    }
    pageToken = rowsJson.nextPageToken;
  } while (pageToken);

  return all;
}

function parseGamDate(v: any): string | null {
  const raw = String(v?.stringValue ?? v?.intValue ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return null;
}

async function getAccessToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${enc(header)}.${enc(claim)}`;
  const pem = sa.private_key.replace(/\\n/g, "\n");
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const key = await crypto.subtle.importKey("pkcs8", buf.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${unsigned}.${sigB64}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
  return j.access_token as string;
}
