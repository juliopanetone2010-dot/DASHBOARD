// Sincroniza receita do Google Ad Manager (REST API v1 beta)
// - Autentica via JWT (service account)
// - Roda 2 reports: por AD_UNIT_NAME e por PLACEMENT_NAME
// - Faz upsert em `placements` e atualiza `revenue/impressions/ecpm`
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";
const ALLOWED_PRESETS = new Set(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const debug: string[] = [];
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    let datePreset = "LAST_7_DAYS";
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    let requestedSiteId: string | null = null;
    let requestedAccountIds: string[] = [];
    let includeYesterdayFallback = false;
    let testMode = false;
    try {
      const body = await req.json().catch(() => ({}));
      const p = String((body as any)?.date_preset ?? "").toUpperCase();
      if (ALLOWED_PRESETS.has(p)) datePreset = p;
      dateFrom = typeof (body as any)?.from === "string" ? (body as any).from : null;
      dateTo = typeof (body as any)?.to === "string" ? (body as any).to : null;
      requestedSiteId = typeof (body as any)?.site_id === "string" ? (body as any).site_id : null;
      requestedAccountIds = Array.isArray((body as any)?.account_ids)
        ? (body as any).account_ids.filter((id: unknown) => typeof id === "string" && id.length > 0)
        : [];
      includeYesterdayFallback = Boolean((body as any)?.include_yesterday_fallback);
      testMode = Boolean((body as any)?.test);
    } catch (_) { /* */ }

    const saJsonRaw = Deno.env.get("GAM_SERVICE_ACCOUNT_JSON");
    if (!saJsonRaw) return json({ error: "GAM_SERVICE_ACCOUNT_JSON não configurada" });
    let sa: { client_email: string; private_key: string };
    try {
      sa = JSON.parse(saJsonRaw);
    } catch {
      return json({ error: "GAM_SERVICE_ACCOUNT_JSON inválido (não é JSON)" });
    }
    if (!sa.client_email || !sa.private_key) {
      return json({ error: "Service Account JSON sem client_email/private_key" });
    }

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let sitesQuery = admin
      .from("sites")
      .select("id, name, domain, network_code")
      .eq("user_id", userId);
    if (requestedSiteId) sitesQuery = sitesQuery.eq("id", requestedSiteId);
    const { data: sites, error: sErr } = await sitesQuery;
    if (sErr) return json({ error: sErr.message });
    if (!sites || sites.length === 0) return json({ error: "Nenhum site cadastrado" });

    const accessToken = await getAccessToken(sa);
    debug.push("got access token");
    // Receita do GAM fica em USD; gasto do Ads fica na moeda nativa (BRL nas contas BR).
    const fxRates = await getFxRates(debug);

    // Agrupa sites por network_code
    const byNetwork = new Map<string, typeof sites>();
    for (const s of sites) {
      const list = byNetwork.get(s.network_code) ?? [];
      list.push(s);
      byNetwork.set(s.network_code, list);
    }

    const summary: Array<Record<string, unknown>> = [];

    for (const [networkCode, networkSites] of byNetwork) {
      try {
        const ranges = buildGamRanges(datePreset, dateFrom, dateTo, includeYesterdayFallback);
        const adUnitRows = (await Promise.all(ranges.map((range) => runReport(networkCode, accessToken, range, "AD_UNIT_NAME", debug)))).flat();
        const placementRows = (await Promise.all(ranges.map((range) => runReport(networkCode, accessToken, range, "PLACEMENT_NAME", debug)))).flat();

        const canonicalRows = adUnitRows.length > 0 ? adUnitRows : placementRows;
        const totals = canonicalRows.reduce(
          (acc, r) => ({
            revenue: acc.revenue + r.revenue,
            impressions: acc.impressions + r.impressions,
          }),
          { revenue: 0, impressions: 0 },
        );
        const today = new Date().toISOString().slice(0, 10);

        // Persiste rows como placements (uma linha por dia x dimensão)
        const persistRows = async (rows: ReportRow[], kind: "ad_unit" | "placement") => {
          for (const r of rows) {
            const revenue = r.revenue;
            const impressions = r.impressions;
            const ecpm = impressions > 0 ? (revenue / impressions) * 1000 : 0;
            const siteForRow = networkSites[0]; // GAM não retorna domínio; usa 1º site da network
            const placementKey = `${kind}:${networkCode}:${r.name}`;

            await admin.from("placements").upsert(
              {
                user_id: userId,
                site_id: siteForRow.id,
                site: siteForRow.name,
                ad_unit: kind === "ad_unit" ? r.name : null,
                placement_key: placementKey,
                date: r.date ?? today,
                impressions,
                revenue,
                ecpm,
              },
              { onConflict: "user_id,placement_key,date" },
            );
          }
        };

        if (!testMode) {
          await persistRows(adUnitRows, "ad_unit");
          await persistRows(placementRows, "placement");
          await distributeGamRevenueToCampaigns(admin, userId, networkSites[0]?.id, canonicalRows, fxRates, debug, requestedAccountIds);
        }

        summary.push({
          network_code: networkCode,
          sites: networkSites.map((s) => s.name),
          ad_unit_rows: adUnitRows.length,
          placement_rows: placementRows.length,
          currency: "USD",
          usd_brl_rate: fxRates.usdBrl,
          total_revenue_usd: totals.revenue,
          total_impressions: totals.impressions,
          date_range: ranges.map((r) => r.debugLabel),
          site_id: requestedSiteId ?? null,
          rows_returned: canonicalRows.length,
          ecpm: totals.impressions > 0 ? (totals.revenue / totals.impressions) * 1000 : 0,
        });
      } catch (e) {
        summary.push({ network_code: networkCode, error: String(e) });
      }
    }

    const hasErrors = summary.some((s) => typeof s.error === "string");

    // Atualiza last_synced_at/status sem marcar como conectado quando o GAM recusou a chamada
    await admin.from("gam_accounts")
      .update({ last_synced_at: new Date().toISOString(), status: hasErrors ? "pending" : "connected" })
      .eq("user_id", userId);

    return json({ ok: true, date_preset: datePreset, summary, debug });
  } catch (e) {
    console.error("[gam-sync-revenue] uncaught", e);
    return json({ error: String(e), debug });
  }
});

interface ReportRow { date: string | null; name: string; impressions: number; revenue: number; }

interface FxRates { usdBrl: number; }

interface GamRange { dateRange: Record<string, unknown>; debugLabel: string; }

async function getFxRates(debug: string[]): Promise<FxRates> {
  try {
    const res = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL");
    const data = await res.json();
    const rate = Number(data?.USDBRL?.bid);
    if (Number.isFinite(rate) && rate > 0) {
      debug.push(`[currency] USD→BRL ${rate}`);
      return { usdBrl: rate };
    }
  } catch (e) {
    debug.push(`[currency] falha cotação, fallback 5.5: ${String(e)}`);
  }
  return { usdBrl: 5.5 };
}

function buildGamRanges(datePreset: string, from: string | null, to: string | null, includeYesterdayFallback: boolean): GamRange[] {
  const valid = (d: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const fixed = (start: string, end: string): GamRange => ({
    dateRange: { fixed: { startDate: dateObj(start), endDate: dateObj(end) } },
    debugLabel: `${start}..${end}`,
  });
  const ranges = valid(from) && valid(to)
    ? [fixed(from!, to!)]
    : [{ dateRange: { relative: datePreset }, debugLabel: datePreset }];
  if (includeYesterdayFallback) {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const iso = y.toISOString().slice(0, 10);
    if (!ranges.some((r) => r.debugLabel.includes(iso))) ranges.push(fixed(iso, iso));
  }
  return ranges;
}

function dateObj(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

async function distributeGamRevenueToCampaigns(
  admin: any,
  userId: string,
  siteId: string | undefined,
  rows: ReportRow[],
  _fx: FxRates,
  debug: string[],
  requestedAccountIds: string[] = [],
) {
  if (!siteId || rows.length === 0) return;

  const totalsByDate = new Map<string, { revenue: number; impressions: number }>();
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    const date = r.date ?? today;
    const cur = totalsByDate.get(date) ?? { revenue: 0, impressions: 0 };
    cur.revenue += r.revenue;
    cur.impressions += r.impressions;
    totalsByDate.set(date, cur);
  }

  const { data: links, error: linksErr } = await admin
    .from("account_site_links")
    .select("google_account_id")
    .eq("user_id", userId)
    .eq("site_id", siteId);
  if (linksErr || !links?.length) {
    debug.push(`[daily_metrics] sem vínculo Ads↔site para distribuir receita GAM`);
    return;
  }

  const linkedAccountIds = links.map((l: any) => l.google_account_id).filter(Boolean);
  const accountIds = requestedAccountIds.length > 0
    ? linkedAccountIds.filter((id: string) => requestedAccountIds.includes(id))
    : linkedAccountIds;
  if (accountIds.length === 0) {
    debug.push(`[daily_metrics] nenhuma conta Ads selecionada está vinculada ao site`);
    return;
  }
  for (const [date, totals] of totalsByDate) {
    const { data: metrics, error: metricsErr } = await admin
      .from("daily_metrics")
      .select("id, campaign_id, spend, impressions")
      .eq("user_id", userId)
      .eq("date", date)
      .in("google_account_id", accountIds);
    if (metricsErr || !metrics?.length) {
      debug.push(`[daily_metrics] sem campanhas Ads em ${date} para distribuir receita GAM`);
      continue;
    }

    const totalWeight = metrics.reduce((acc: number, m: any) => acc + Math.max(Number(m.impressions ?? 0), 0), 0) || metrics.length;
    for (const m of metrics as any[]) {
      const weight = totalWeight === metrics.length ? 1 : Math.max(Number(m.impressions ?? 0), 0);
      const share = weight / totalWeight;
      // Receita armazenada em USD (nativa do GAM)
      const revenueUsd = totals.revenue * share;
      // Spend está em BRL (nativo do Ads). Para profit/ROI/ROAS, convertemos receita USD→BRL.
      const spendBrl = Number(m.spend ?? 0);
      const revenueBrl = revenueUsd * _fx.usdBrl;
      const impressions = Number(m.impressions ?? 0);
      const profit = revenueBrl - spendBrl;
      const roi = spendBrl > 0 ? (profit / spendBrl) * 100 : 0;
      const roas = spendBrl > 0 ? revenueBrl / spendBrl : 0;
      const ecpm = impressions > 0 ? (revenueBrl / impressions) * 1000 : 0;
      await admin.from("daily_metrics").update({ revenue: revenueUsd, profit, roi, roas, ecpm }).eq("id", m.id);
    }
    debug.push(`[daily_metrics] receita GAM ${totals.revenue.toFixed(6)} USD distribuída em ${metrics.length} campanha(s) de ${date} (fx ${_fx.usdBrl})`);
  }
}

async function runReport(
  networkCode: string,
  accessToken: string,
  range: GamRange,
  groupDim: "AD_UNIT_NAME" | "PLACEMENT_NAME",
  debug: string[],
): Promise<ReportRow[]> {
  // 1) cria report
  const reportBody = {
    visibility: "DRAFT",
    reportDefinition: {
      reportType: "HISTORICAL",
      dimensions: ["DATE", groupDim],
      metrics: [
        "AD_SERVER_IMPRESSIONS",
        "AD_SERVER_REVENUE",
        "AD_EXCHANGE_IMPRESSIONS",
        "AD_EXCHANGE_REVENUE",
        "ADSENSE_IMPRESSIONS",
        "ADSENSE_REVENUE",
      ],
      dateRange: range.dateRange,
    },
  };
  const createRes = await fetch(
    `${GAM_BASE}/networks/${networkCode}/reports`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reportBody),
    },
  );
  const createText = await createRes.text();
  debug.push(`[${networkCode}/${groupDim}] create status=${createRes.status}`);
  let createJson: any;
  try { createJson = JSON.parse(createText); }
  catch {
    throw new Error(
      "Google Ad Manager API não está habilitada no projeto do Google Cloud da Service Account. Acesse https://console.cloud.google.com/apis/library/admanager.googleapis.com, selecione o projeto correto e clique em ENABLE. Depois aguarde ~1 min e sincronize novamente."
    );
  }
  if (!createRes.ok) throw new Error(formatGamError(createRes.status, createJson));
  const reportName: string = createJson.name; // networks/X/reports/Y

  // 2) run report (LRO)
  const runRes = await fetch(`${GAM_BASE}/${reportName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const runJson = await parseJsonResponse(runRes, "run report", networkCode, groupDim);
  debug.push(`[${networkCode}/${groupDim}] run status=${runRes.status}`);
  if (!runRes.ok) throw new Error(`run failed: ${JSON.stringify(runJson)}`);
  const opName: string = runJson.name; // operations/...

  // 3) poll operation até done
  let resultName: string | null = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const opRes = await fetch(`${GAM_BASE}/${opName}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const opJson = await parseJsonResponse(opRes, "poll operation", networkCode, groupDim);
    if (opJson.done) {
      if (opJson.error) throw new Error(`op error: ${JSON.stringify(opJson.error)}`);
      resultName = opJson.response?.reportResult?.name ?? opJson.response?.reportResult ?? opJson.response?.name;
      if (!resultName) throw new Error(`report done sem reportResult: ${JSON.stringify(opJson.response ?? opJson)}`);
      debug.push(`[${networkCode}/${groupDim}] done after ${(i + 1) * 2}s`);
      debug.push(`[${networkCode}/${groupDim}] result=${resultName}`);
      break;
    }
  }
  if (!resultName) throw new Error("report timeout");

  // 4) fetch result rows
  const allRows: ReportRow[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("pageSize", "1000");
    const rowsRes = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    debug.push(`[${networkCode}/${groupDim}] fetchRows status=${rowsRes.status}`);
    const rowsJson = await parseJsonResponse(rowsRes, "fetchRows", networkCode, groupDim);
    if (!rowsRes.ok) throw new Error(`fetchRows failed: ${JSON.stringify(rowsJson)}`);

    const rows = (rowsJson.rows ?? []) as Array<{
      dimensionValues?: Array<{ stringValue?: string; intValue?: string }>;
      metricValueGroups?: Array<{
        primaryValues?: Array<{ intValue?: string; doubleValue?: number }>;
      }>;
    }>;

    for (const r of rows) {
      const dims = r.dimensionValues ?? [];
      const date = parseGamDate(dims[0]);
      const name = dims[1]?.stringValue ?? "(unknown)";
      const m = r.metricValueGroups?.[0]?.primaryValues ?? [];
      const num = (v: any) => Number(v?.intValue ?? v?.doubleValue ?? 0);
      // Impressões: AdServer + AdExchange + AdSense
      const impressions = num(m[0]) + num(m[2]) + num(m[4]);
      // GAM retorna receita em micros de USD. Armazenamos em USD nativo.
      const revenue = (num(m[1]) + num(m[3]) + num(m[5])) / 1_000_000;
      allRows.push({ date, name, impressions, revenue });
    }
    pageToken = rowsJson.nextPageToken;
  } while (pageToken);

  return allRows;
}

function parseGamDate(value: any): string | null {
  const raw = String(value?.stringValue ?? value?.intValue ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return null;
}

async function parseJsonResponse(
  res: Response,
  step: string,
  networkCode: string,
  groupDim: string,
) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 300);
    throw new Error(
      `[${networkCode}/${groupDim}] ${step} retornou resposta não-JSON (status ${res.status}, content-type ${res.headers.get("content-type") ?? "sem content-type"}): ${preview}`,
    );
  }
}

// JWT auth para service account
async function getAccessToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const pem = sa.private_key.replace(/\\n/g, "\n");
  const pkcs8 = pemToArrayBuffer(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8", pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${unsigned}.${sigB64}`;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
  return j.access_token as string;
}

function pemToArrayBuffer(pem: string) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function formatGamError(status: number, payload: any) {
  const reason = payload?.error?.details?.find((d: any) => d?.reason)?.reason;
  if (status === 401 || reason === "AUTH_ERROR_AUTHENTICATION_FAILED") {
    return "GAM não autenticou a Service Account. No Google Ad Manager, adicione o email da Service Account como usuário da rede e libere permissão para ver/executar relatórios; se estiver pendente, aprove o usuário antes de sincronizar.";
  }
  return `create report failed: ${JSON.stringify(payload)}`;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
