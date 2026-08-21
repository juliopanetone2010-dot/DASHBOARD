// Retorna a última hora com impressões no GAM para uma data específica.
// Usa report HISTORICAL com dimensions=[DATE, HOUR] e metric AD_SERVER_IMPRESSIONS.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";

// Semáforo + backoff: serializa chamadas ao GAM e estende retries para evitar 429.
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
    } finally {
      release();
    }
  }
  return gamFetchRaw(input, init, attempt);
}
async function gamFetchRaw(input: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(input, init);
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    const backoff = retryAfter > 0 ? retryAfter * 1000 : [3000, 8000, 20000, 45000][attempt];
    console.warn(`[gam-last-hour] ${res.status} — backoff ${backoff}ms (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, backoff));
    return gamFetchRaw(input, init, attempt + 1);
  }
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const date: string = typeof (body as any)?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test((body as any).date)
      ? (body as any).date
      : new Date().toISOString().slice(0, 10);
    const requestedSiteId: string | null = typeof (body as any)?.site_id === "string" ? (body as any).site_id : null;

    const saJsonRaw = Deno.env.get("GAM_SERVICE_ACCOUNT_JSON");
    if (!saJsonRaw) return json({ error: "GAM_SERVICE_ACCOUNT_JSON não configurada" });
    const sa = JSON.parse(saJsonRaw) as { client_email: string; private_key: string };

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let sitesQuery = admin.from("sites").select("id, network_code").eq("user_id", userId);
    if (requestedSiteId && requestedSiteId !== "all") sitesQuery = sitesQuery.eq("id", requestedSiteId);
    const { data: sites } = await sitesQuery;
    if (!sites || sites.length === 0) return json({ ok: true, date, lastHour: null, status: "no_site" });

    const accessToken = await getAccessToken(sa);

    const networks = Array.from(new Set(sites.map((s) => s.network_code)));
    // Cruzamento HOUR + IMPRESSIONS — soma impressões por hora entre todas as redes
    const hourMap = new Map<number, number>();
    const debugRows: any[] = [];

    // Processa redes em PARALELO — gamQueue serializa os HTTP calls,
    // mas os sleeps de polling não bloqueiam outras redes (evita 150s timeout).
    await Promise.all(networks.map(async (networkCode) => {
      try {
        const rows = await runHourReport(networkCode, accessToken, date);
        debugRows.push({
          networkCode,
          rowCount: rows.length,
          rows: rows.map((r) => ({ h: r.hour, impr: r.impressions })),
        });
        for (const r of rows) {
          if (!Number.isFinite(r.hour) || r.hour < 0 || r.hour > 23) continue;
          if (r.impressions > 0) {
            hourMap.set(r.hour, (hourMap.get(r.hour) ?? 0) + r.impressions);
          }
        }
      } catch (e) {
        console.error("[gam-last-hour]", networkCode, String(e));
        debugRows.push({ networkCode, error: String(e) });
      }
    }));

    const hours = [...hourMap.entries()]
      .map(([hour, impressions]) => ({ hour, impressions }))
      .sort((a, b) => a.hour - b.hour);
    const maxHour = hours.length > 0 ? Math.max(...hours.map((h) => h.hour)) : -1;
    const totalImpr = hours.reduce((s, h) => s + h.impressions, 0);

    const today = new Date().toISOString().slice(0, 10);
    const isToday = date === today;
    const isYesterday = (() => {
      const y = new Date(); y.setDate(y.getDate() - 1);
      return y.toISOString().slice(0, 10) === date;
    })();

    let label: string;
    if (maxHour < 0) {
      label = isToday ? "Sem dados do GAM ainda" : `Sem dados em ${date}`;
    } else if (isYesterday && maxHour >= 23) {
      label = "Dados completos até 23:59";
    } else {
      label = `Ad Manager atualizado até: ${String(maxHour).padStart(2, "0")}:59`;
    }

    return json({
      ok: true,
      date,
      lastHour: maxHour >= 0 ? maxHour : null,
      totalImpressions: totalImpr,
      hours,
      label,
      isToday,
      isYesterday,
      debug: debugRows,
    });
  } catch (e) {
    console.error("[gam-last-hour] uncaught", e);
    return json({ error: String(e) });
  }
});

async function runHourReport(networkCode: string, accessToken: string, date: string): Promise<Array<{ hour: number; impressions: number }>> {
  const [year, month, day] = date.split("-").map(Number);
  const reportDefinition = {
    reportType: "HISTORICAL",
    dimensions: ["DATE", "HOUR"],
    metrics: ["AD_SERVER_IMPRESSIONS", "AD_EXCHANGE_IMPRESSIONS", "ADSENSE_IMPRESSIONS"],
    dateRange: { fixed: { startDate: { year, month, day }, endDate: { year, month, day } } },
    // Usa o fuso da rede (mesmo que o usuário vê na UI do GAM)
    timeZoneSource: "PUBLISHER",
  };
  const createRes = await gamFetch(`${GAM_BASE}/networks/${networkCode}/reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ reportDefinition }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok) throw new Error(`create failed: ${JSON.stringify(createJson)}`);
  const reportName: string = createJson.name;

  const runRes = await gamFetch(`${GAM_BASE}/${reportName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const runJson = await runRes.json();
  if (!runRes.ok) throw new Error(`run failed: ${JSON.stringify(runJson)}`);
  const opName: string = runJson.name;

  let resultName: string | null = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const opRes = await gamFetch(`${GAM_BASE}/${opName}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const opJson = await opRes.json();
    if (opJson.done) {
      if (opJson.error) throw new Error(`op error: ${JSON.stringify(opJson.error)}`);
      resultName = opJson.response?.reportResult?.name ?? opJson.response?.reportResult ?? opJson.response?.name;
      break;
    }
  }
  if (!resultName) throw new Error("report timeout");

  const out: Array<{ hour: number; impressions: number }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    const rowsRes = await gamFetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const rowsJson = await rowsRes.json();
    if (!rowsRes.ok) throw new Error(`fetchRows failed: ${JSON.stringify(rowsJson)}`);
    const rows = (rowsJson.rows ?? []) as Array<{
      dimensionValues?: Array<{ stringValue?: string; intValue?: string }>;
      metricValueGroups?: Array<{ primaryValues?: Array<{ intValue?: string; doubleValue?: number }> }>;
    }>;
    for (const r of rows) {
      const dims = r.dimensionValues ?? [];
      const hourRaw = dims[1]?.intValue ?? dims[1]?.stringValue ?? "";
      const hour = Number(hourRaw);
      const m = r.metricValueGroups?.[0]?.primaryValues ?? [];
      const num = (v: any) => Number(v?.intValue ?? v?.doubleValue ?? 0);
      const impressions = num(m[0]) + num(m[1]) + num(m[2]);
      if (Number.isFinite(hour)) out.push({ hour, impressions });
    }
    pageToken = rowsJson.nextPageToken;
  } while (pageToken);

  return out;
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
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
