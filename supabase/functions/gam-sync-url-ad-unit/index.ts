// Sincroniza métricas do GAM cruzando URL_NAME x AD_UNIT_NAME.
// Popula a tabela `gam_url_ad_unit_daily` para o cálculo de "Melhor Match por Bloco".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";

let gamQueue: Promise<unknown> = Promise.resolve();
const GAM_MIN_INTERVAL_MS = 350;
let lastGamCallAt = 0;
async function gamFetch(input: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  if (attempt === 0) {
    const prev = gamQueue;
    let release: () => void = () => {};
    gamQueue = new Promise<void>((r) => (release = r));
    try {
      await prev;
      const since = Date.now() - lastGamCallAt;
      if (since < GAM_MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, GAM_MIN_INTERVAL_MS - since));
      lastGamCallAt = Date.now();
      return await gamFetchRaw(input, init, 0);
    } finally { release(); }
  }
  return gamFetchRaw(input, init, attempt);
}
async function gamFetchRaw(input: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(input, init);
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    const backoff = retryAfter > 0 ? retryAfter * 1000 : [3000, 8000, 20000, 45000][attempt];
    await new Promise((r) => setTimeout(r, backoff));
    return gamFetchRaw(input, init, attempt + 1);
  }
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const control = await req.clone().json().catch(() => ({}));
  const wait = control?.wait === true;
  if (wait) return await runSync(req);

  const work = runSync(req).catch((e) => console.error("[gam-sync-url-ad-unit] bg error", e));
  // @ts-ignore EdgeRuntime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
  return new Response(JSON.stringify({ ok: true, status: "started" }), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

async function runSync(req: Request): Promise<Response> {
  const debug: string[] = [];
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({} as any));
    const dateFrom: string | null = typeof body?.from === "string" ? body.from : (typeof body?.date_from === "string" ? body.date_from : null);
    const dateTo: string | null = typeof body?.to === "string" ? body.to : (typeof body?.date_to === "string" ? body.date_to : null);
    const requestedSiteId: string | null = typeof body?.site_id === "string" ? body.site_id : null;
    const requestedUserId: string | null = typeof body?.user_id === "string" ? body.user_id : null;

    if (!dateFrom || !dateTo || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return json({ error: "Informe from/to no formato YYYY-MM-DD" });
    }

    const saJsonRaw = Deno.env.get("GAM_SERVICE_ACCOUNT_JSON");
    if (!saJsonRaw) return json({ error: "GAM_SERVICE_ACCOUNT_JSON não configurada" });
    const sa = JSON.parse(saJsonRaw);

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const token = authHeader.replace("Bearer ", "");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    let userId: string | undefined;
    if (token && serviceRoleKey && token === serviceRoleKey) {
      userId = requestedUserId ?? undefined;
    } else {
      const { data: claims } = await userClient.auth.getClaims(token);
      userId = claims?.claims?.sub;
    }
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let sitesQuery = admin.from("sites").select("id, name, network_code").eq("user_id", userId);
    if (requestedSiteId) sitesQuery = sitesQuery.eq("id", requestedSiteId);
    const { data: sites, error: sErr } = await sitesQuery;
    if (sErr) return json({ error: sErr.message });
    if (!sites || sites.length === 0) return json({ error: "Nenhum site cadastrado" });

    // Mapa network_code -> google_account_id (primeira conta encontrada)
    const { data: accounts } = await admin.from("google_accounts").select("id, network_code").eq("user_id", userId);
    const accountByNetwork = new Map<string, string>();
    for (const a of (accounts ?? []) as any[]) {
      if (a.network_code && !accountByNetwork.has(a.network_code)) accountByNetwork.set(a.network_code, a.id);
    }

    const accessToken = await getAccessToken(sa);
    debug.push("got access token");

    const byNetwork = new Map<string, typeof sites>();
    for (const s of sites) {
      if (!s.network_code) continue;
      const list = byNetwork.get(s.network_code) ?? [];
      list.push(s); byNetwork.set(s.network_code, list);
    }

    const range = buildRange(dateFrom, dateTo);
    const summary: any[] = [];
    let totalUpserts = 0;

    for (const [networkCode, netSites] of byNetwork) {
      try {
        const rows = await runReportSafe(networkCode, accessToken, range, debug);
        debug.push(`[${networkCode}] rows=${rows.length}`);

        // Agrupa por (date, campaign_id, ad_unit_name)
        const agg = new Map<string, {
          date: string; campaign_id: string; ad_unit_name: string;
          ad_requests: number; matched_impressions: number; revenue_usd: number;
        }>();
        let noCampaign = 0;
        for (const r of rows) {
          if (!r.date || !r.ad_unit_name) continue;
          const cid = extractCampaignId(r.key_values_raw);
          if (!cid) { noCampaign++; continue; }
          const key = `${r.date}|${cid}|${r.ad_unit_name}`;
          const cur = agg.get(key) ?? {
            date: r.date, campaign_id: cid, ad_unit_name: r.ad_unit_name,
            ad_requests: 0, matched_impressions: 0, revenue_usd: 0,
          };
          cur.ad_requests += r.ad_requests;
          cur.matched_impressions += r.matched_impressions;
          cur.revenue_usd += r.revenue_usd;
          agg.set(key, cur);
        }
        debug.push(`[${networkCode}] rows_sem_campaign=${noCampaign}`);

        const accountId = accountByNetwork.get(networkCode) ?? null;
        const siteId = netSites.length === 1 ? netSites[0].id : null;

        const upserts = [...agg.values()].map((v) => ({
          user_id: userId!,
          google_account_id: accountId,
          site_id: siteId,
          date: v.date,
          campaign_id: v.campaign_id,
          ad_unit_name: v.ad_unit_name,
          ad_requests: v.ad_requests,
          matched_impressions: v.matched_impressions,
          revenue_usd: v.revenue_usd,
          match_rate_pct: v.ad_requests > 0 ? (v.matched_impressions / v.ad_requests) * 100 : null,
        }));

        // Upsert em lotes
        const CHUNK = 500;
        for (let i = 0; i < upserts.length; i += CHUNK) {
          const chunk = upserts.slice(i, i + CHUNK);
          const { error } = await admin
            .from("gam_url_ad_unit_daily")
            .upsert(chunk, { onConflict: "user_id,google_account_id,date,campaign_id,ad_unit_name" });
          if (error) { debug.push(`[${networkCode}] upsert err: ${error.message}`); break; }
          totalUpserts += chunk.length;
        }

        summary.push({ networkCode, rows: rows.length, upserts: upserts.length });
      } catch (e) {
        debug.push(`[${networkCode}] erro: ${String((e as Error).message ?? e).slice(0, 300)}`);
        summary.push({ networkCode, error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }

    return json({ ok: true, summary, totalUpserts, debug });
  } catch (e) {
    console.error("[gam-sync-url-ad-unit] fatal", e);
    return json({ error: String((e as Error).message ?? e), debug });
  }
}

type ReportOut = {
  date: string; ad_unit_name: string; key_values_raw: string;
  ad_requests: number; matched_impressions: number; revenue_usd: number;
};

async function runReportSafe(networkCode: string, accessToken: string, range: any, debug: string[]): Promise<ReportOut[]> {
  const metricSets: Array<{ metrics: string[]; kind: "ad_requests" | "match_rate" }> = [
    { metrics: ["AD_REQUESTS", "AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE"], kind: "ad_requests" },
    { metrics: ["AD_EXCHANGE_MATCH_RATE", "AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE"], kind: "match_rate" },
  ];
  let lastErr: unknown = null;
  for (const set of metricSets) {
    try {
      const raw = await runReport(networkCode, accessToken, range, ["DATE", "AD_UNIT_NAME", "KEY_VALUES_NAME"], set.metrics, debug);
      const out: ReportOut[] = raw.map((r) => {
        const date = r.date;
        const ad_unit_name = r.dims[1] ?? "";
        const key_values_raw = r.dims[2] ?? "";
        const m0 = r.metrics[0] ?? 0;
        const impressions = r.metrics[1] ?? 0;
        const revenue = r.metrics[2] ?? 0;
        let ad_requests = 0;
        if (set.kind === "ad_requests") ad_requests = Math.round(m0);
        else ad_requests = m0 > 0 ? Math.round(impressions / m0) : 0;
        return { date: date ?? "", ad_unit_name, key_values_raw, ad_requests, matched_impressions: Math.round(impressions), revenue_usd: revenue };
      }).filter((r) => r.date && r.ad_unit_name);
      debug.push(`[${networkCode}] usou métricas: ${set.kind}`);
      return out;
    } catch (e) {
      lastErr = e;
      debug.push(`[${networkCode}] falhou métricas ${set.kind}: ${String((e as Error).message ?? e).slice(0, 200)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Falha ao rodar report");
}

async function runReport(networkCode: string, accessToken: string, range: any, dimensions: string[], metrics: string[], debug: string[]) {
  const tag = `${networkCode}/${dimensions.join("+")}`;
  const reportBody = {
    visibility: "DRAFT",
    reportDefinition: { reportType: "HISTORICAL", dimensions, metrics, dateRange: range },
  };
  const createRes = await gamFetch(`${GAM_BASE}/networks/${networkCode}/reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(reportBody),
  });
  const createText = await createRes.text();
  if (!createRes.ok) throw new Error(`[${tag}] create failed (${createRes.status}): ${createText.slice(0, 400)}`);
  const createJson = JSON.parse(createText);
  const reportName: string = createJson.name;

  const runRes = await gamFetch(`${GAM_BASE}/${reportName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const runJson = await runRes.json();
  if (!runRes.ok) throw new Error(`[${tag}] run failed: ${JSON.stringify(runJson)}`);
  const opName: string = runJson.name;

  let resultName: string | null = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const opRes = await gamFetch(`${GAM_BASE}/${opName}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const opJson = await opRes.json();
    if (opJson.done) {
      if (opJson.error) throw new Error(`[${tag}] op error: ${JSON.stringify(opJson.error)}`);
      resultName = opJson.response?.reportResult?.name ?? opJson.response?.reportResult ?? opJson.response?.name;
      break;
    }
  }
  if (!resultName) throw new Error(`[${tag}] report timeout`);

  const out: Array<{ date: string | null; dims: string[]; metrics: number[] }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    const rowsRes = await gamFetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const rowsJson = await rowsRes.json();
    if (!rowsRes.ok) throw new Error(`[${tag}] fetchRows failed: ${JSON.stringify(rowsJson)}`);
    const rows = (rowsJson.rows ?? []) as any[];
    for (const r of rows) {
      const dimsVals = r.dimensionValues ?? [];
      const date = parseGamDate(dimsVals[0]);
      const dimStrings = dimsVals.map((d: any) => d?.stringValue ?? d?.intValue ?? "");
      const m = r.metricValueGroups?.[0]?.primaryValues ?? [];
      const numRev = (v: any) => {
        if (v == null) return 0;
        if (v.intValue != null) return Number(v.intValue) / 1_000_000;
        if (v.doubleValue != null) return Number(v.doubleValue);
        return 0;
      };
      const numRaw = (v: any) => Number(v?.intValue ?? v?.doubleValue ?? 0);
      const metricNums: number[] = metrics.map((name, idx) => {
        return /REVENUE/i.test(name) ? numRev(m[idx]) : numRaw(m[idx]);
      });
      out.push({ date, dims: dimStrings, metrics: metricNums });
    }
    pageToken = rowsJson.nextPageToken;
  } while (pageToken);
  return out;
}

function parseGamDate(value: any): string | null {
  const raw = String(value?.stringValue ?? value?.intValue ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
  return null;
}

// KEY_VALUES_NAME retorna uma string com pares "chave=valor" (ex.: "utm_campaign=23158084688").
// Priorizamos utm_campaign, depois cid, depois campaign_id, e por último um número longo isolado.
function extractCampaignId(raw: string): string | null {
  if (!raw) return null;
  const s = String(raw);
  const patterns = [
    /utm_campaign\s*=\s*(\d{6,20})/i,
    /(?:^|[^\w])cid\s*=\s*(\d{6,20})/i,
    /campaign_?id\s*=\s*(\d{6,20})/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}



function buildRange(from: string, to: string) {
  const p = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return { year: y, month: m, day };
  };
  return { fixed: { startDate: p(from), endDate: p(to) } };
}

async function getAccessToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${enc(header)}.${enc(claim)}`;
  const pem = sa.private_key.replace(/\\n/g, "\n");
  const pkcs8 = pemToArrayBuffer(pem);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
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

function pemToArrayBuffer(pem: string) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
