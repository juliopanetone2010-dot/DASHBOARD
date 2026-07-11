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
  sourceDimension: string;
}

interface DebugReport {
  totalRowsFromGam: number;
  rowsReceivedGam: number;
  matchedPush: number;
  rowsWithUtmPush: number;
  rowsInserted: number;
  rowsIgnored: number;
  ignoredNoPush: number;
  aggregateRows: number;
  duplicates: number;
  ecpmAnomalies: number;
  discardReasons: Record<string, number>;
  parserSources: Record<string, number>;
  reportModes: string[];
  lastError: string | null;
  sampleIgnored: string[];
  sampleMatched: string[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let syncUserId: string | null = null;
  let syncSiteId: string | null = null;
  let syncAdmin: any = null;
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
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    syncAdmin = admin;

    const token = authHeader.replace("Bearer ", "");
    let userId: string | null = null;
    if (token && token === SERVICE_KEY) {
      userId = typeof body?.user_id === "string" ? body.user_id : null;
      if (!userId) return json({ error: "user_id obrigatório em chamada interna" }, 400);
    } else {
      const user = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: u, error: uErr } = await user.auth.getUser();
      if (uErr || !u?.user) return json({ error: "Sessão inválida" }, 401);
      userId = u.user.id;
      const { data: canAccess } = await admin.rpc("can_access_site", { _uid: userId, _site_id: siteId });
      if (!canAccess) return json({ error: "Sem acesso a este site" }, 403);
    }


    // Carrega site
    const { data: site, error: sErr } = await admin
      .from("sites")
      .select("id, user_id, network_code, name, domain, gam_currency")
      .eq("id", siteId)
      .maybeSingle();
    if (sErr || !site) return json({ error: "Site não encontrado" }, 404);
    if (!site.network_code) return json({ error: "Site sem network_code do GAM" }, 400);
    syncUserId = site.user_id;
    syncSiteId = siteId;
    const siteCurrency = String(site.gam_currency ?? "USD").toUpperCase();
    const ingestionDivisor = siteCurrency === "BRL" ? await getUsdBrlRate(admin) : 1;

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
      rowsReceivedGam: rows.length,
      matchedPush: 0,
      rowsWithUtmPush: 0,
      rowsInserted: 0,
      rowsIgnored: 0,
      ignoredNoPush: 0,
      aggregateRows: 0,
      duplicates: 0,
      discardReasons: {},
      parserSources: {},
      reportModes: [...new Set(rows.map((r) => r.sourceDimension))],
      lastError: null,
      ecpmAnomalies: 0,
      sampleIgnored: [],
      sampleMatched: [],
    };

    const discard = (reason: string, sample?: string) => {
      debug.rowsIgnored++;
      debug.discardReasons[reason] = (debug.discardReasons[reason] ?? 0) + 1;
      if (sample && debug.sampleIgnored.length < 12) debug.sampleIgnored.push(`${reason}|${sample}`);
    };

    // Bucketiza por (date, normalized_url)
    type Bucket = {
      date: string;
      url: string;
      normalized_url: string;
      utm_source: string;
      revenue_usd: number;
      impressions: number;
      raw_gam_row: any;
    };
    const buckets = new Map<string, Bucket>();
    const unattribBuckets = new Map<string, { date: string; revenue_usd: number; impressions: number; reason: string; raw: any }>();
    const seenKeys = new Set<string>();
    const rootAggregateRows = detectRootAggregateRows(rows, site.domain);
    for (const remainder of rootAggregateRows.remainders) {
      if (remainder.revenue_usd <= 0 && remainder.impressions <= 0) continue;
      const k = `${remainder.date}|root_remainder|push`;
      unattribBuckets.set(k, {
        date: remainder.date,
        revenue_usd: remainder.revenue_usd,
        impressions: remainder.impressions,
        reason: "aggregate root remainder utm=push",
        raw: remainder.raw,
      });
      debug.aggregateRows++;
    }

    for (const r of rows) {
      if (rootAggregateRows.excluded.has(r)) {
        debug.aggregateRows++;
        continue;
      }
      if (!r.date) { discard("sem_data", `${r.sourceDimension}|${r.url || r.rawKv}`); continue; }
      const parsed = detectUtmSource(r);
      const utmSource = parsed.utmSource;
      debug.parserSources[parsed.source] = (debug.parserSources[parsed.source] ?? 0) + 1;

      // Aggregate URLs (sem URL exata) vão pra tabela separada
      if (isAggregateUrl(r.url)) {
        debug.aggregateRows++;
        if (utmSource !== "push") {
          debug.ignoredNoPush++;
          discard("agregada_sem_push", `${r.date}|utm=${utmSource}|${r.sourceDimension}|${r.rawKv.slice(0, 120)}`);
          continue;
        }
        const k = `${r.date}|aggregate|${utmSource}`;
        const cur = unattribBuckets.get(k) ?? { date: r.date, revenue_usd: 0, impressions: 0, reason: `aggregate utm=${utmSource}`, raw: r };
        cur.revenue_usd += r.revenue;
        cur.impressions += r.impressions;
        unattribBuckets.set(k, cur);
        debug.matchedPush++;
        debug.rowsWithUtmPush++;
        continue;
      }

      const urlForStorage = withSiteDomain(r.url, site.domain);
      const normalized = normalizePushUrl(urlForStorage);
      if (!normalized) {
        debug.aggregateRows++;
        discard("url_normalizada_vazia", `${r.date}|utm=${utmSource}|${r.url}`);
        continue;
      }
      if (utmSource !== "push") {
        debug.ignoredNoPush++;
        discard("utm_diferente_de_push", `${r.date}|utm=${utmSource}|${r.sourceDimension}|${normalized.slice(0, 80)}`);
        continue;
      }
      const key = `${r.date}|${normalized}|${utmSource}`;
      if (seenKeys.has(key)) debug.duplicates++;
      seenKeys.add(key);

      const cur = buckets.get(key) ?? {
        date: r.date, url: urlForStorage, normalized_url: normalized, utm_source: utmSource,
        revenue_usd: 0, impressions: 0, raw_gam_row: r,
      };
      cur.revenue_usd += r.revenue;
      cur.impressions += r.impressions;
      buckets.set(key, cur);
      debug.matchedPush++;
      debug.rowsWithUtmPush++;
      if (debug.sampleMatched.length < 5) {
        debug.sampleMatched.push(`${r.date}|utm=${utmSource}|via=${parsed.source}|${normalized.slice(0, 80)}|rev=${r.revenue.toFixed(4)}|imp=${r.impressions}`);
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
      const normalizedRevenueUsd = b.revenue_usd / ingestionDivisor;
      const ecpm = b.impressions > 0 ? (normalizedRevenueUsd / b.impressions) * 1000 : 0;
      if (ecpm > 1000 || (b.revenue_usd > 0 && ecpm < 0.01)) debug.ecpmAnomalies++;
      return {
        user_id: site.user_id,
        site_id: siteId,
        date: b.date,
        url: b.url,
        normalized_url: b.normalized_url,
        utm_source: b.utm_source,
        revenue_usd: normalizedRevenueUsd,
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
    debug.rowsInserted = inserts.length;

    const unattribInserts = [...unattribBuckets.values()].map((b) => ({
      user_id: site.user_id,
      site_id: siteId,
      date: b.date,
      revenue_usd: b.revenue_usd / ingestionDivisor,
      impressions: b.impressions,
      reason: b.reason,
      raw_gam_row: b.raw,
    }));
    if (unattribInserts.length) {
      const { error } = await admin.from("unattributed_push_revenue").insert(unattribInserts);
      if (error) throw new Error(`insert unattributed_push_revenue: ${error.message}`);
    }
    await admin.from("gam_campaign_source_revenue")
      .delete()
      .eq("user_id", site.user_id)
      .eq("site_id", siteId)
      .eq("campaign_id", "__aggregate__")
      .eq("utm_source", "push")
      .gte("date", from)
      .lte("date", to);
    const sourceTotals = new Map<string, { date: string; revenue_usd: number; impressions: number }>();
    for (const row of inserts) {
      const cur = sourceTotals.get(row.date) ?? { date: row.date, revenue_usd: 0, impressions: 0 };
      cur.revenue_usd += Number(row.revenue_usd || 0);
      cur.impressions += Number(row.impressions || 0);
      sourceTotals.set(row.date, cur);
    }
    for (const row of unattribInserts) {
      const cur = sourceTotals.get(row.date) ?? { date: row.date, revenue_usd: 0, impressions: 0 };
      cur.revenue_usd += Number(row.revenue_usd || 0);
      cur.impressions += Number(row.impressions || 0);
      sourceTotals.set(row.date, cur);
    }
    const aggregateSourceRows = [...sourceTotals.values()].map((b) => ({
      user_id: site.user_id,
      site_id: siteId,
      campaign_id: "__aggregate__",
      date: b.date,
      utm_source: "push",
      revenue_usd: b.revenue_usd,
      impressions: b.impressions,
    }));
    if (aggregateSourceRows.length) {
      const { error } = await admin
        .from("gam_campaign_source_revenue")
        .upsert(aggregateSourceRows, { onConflict: "user_id,site_id,campaign_id,date,utm_source" });
      if (error) throw new Error(`insert gam_campaign_source_revenue push aggregate: ${error.message}`);
    }
    await setSyncState(admin, site.user_id, siteId, "success", null, inserts.length);

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
    if (syncAdmin && syncUserId && syncSiteId) {
      await setSyncState(syncAdmin, syncUserId, syncSiteId, "error", String((e as Error).message ?? e), 0).catch(() => {});
    }
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function detectUtmSource(r: ReportRow): { utmSource: string; source: string } {
  const kv = parseCustomCriteria(r.rawKv);
  const kvSource = String(kv.utm_source ?? kv.source ?? "").toLowerCase().trim();
  if (kvSource) return { utmSource: kvSource, source: r.sourceDimension.includes("KEY_VALUES") ? r.sourceDimension : "custom_targeting" };
  const urlKv = parseUrlParams(r.url);
  const urlSource = String(urlKv.utm_source ?? urlKv.source ?? "").toLowerCase().trim();
  if (urlSource) return { utmSource: urlSource, source: "URL" };
  return { utmSource: "(none)", source: "not_found" };
}

function withSiteDomain(raw: string | null | undefined, domain: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s) || /^[^/\s]+\.[^/\s]+/.test(s)) return s;
  const d = String(domain ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  if (!d) return s;
  return s.startsWith("/") ? `${d}${s}` : `${d}/${s}`;
}

function detectRootAggregateRows(rows: ReportRow[], domain: string | null | undefined): {
  excluded: Set<ReportRow>;
  remainders: { date: string; revenue_usd: number; impressions: number; raw: any }[];
} {
  const excluded = new Set<ReportRow>();
  const remainders: { date: string; revenue_usd: number; impressions: number; raw: any }[] = [];
  const byDate = new Map<string, ReportRow[]>();
  for (const r of rows) {
    if (!r.date || r.sourceDimension !== "URL_FILTERED_VALUE_ID" || !r.url) continue;
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }

  for (const [date, dateRows] of byDate) {
    const rootRows = dateRows.filter((r) => isSiteRootUrl(r.url, domain));
    if (!rootRows.length || rootRows.length === dateRows.length) continue;
    const detailRows = dateRows.filter((r) => !rootRows.includes(r));
    const rootRevenue = rootRows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    const rootImpressions = rootRows.reduce((s, r) => s + Number(r.impressions || 0), 0);
    const detailRevenue = detailRows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    const detailImpressions = detailRows.reduce((s, r) => s + Number(r.impressions || 0), 0);

    // O dimension URL do GAM pode retornar a linha do domínio raiz como total
    // agregado da UTM, além das URLs específicas. Quando essa linha cobre a soma
    // das URLs detalhadas, ela não deve entrar como URL para não duplicar receita.
    if (rootRevenue + 0.000001 < detailRevenue) continue;
    for (const r of rootRows) excluded.add(r);
    remainders.push({
      date,
      revenue_usd: Math.max(rootRevenue - detailRevenue, 0),
      impressions: Math.max(rootImpressions - detailImpressions, 0),
      raw: rootRows[0],
    });
  }

  return { excluded, remainders };
}

function isSiteRootUrl(raw: string | null | undefined, domain: string | null | undefined): boolean {
  const normalized = normalizePushUrl(withSiteDomain(raw, domain));
  const root = normalizePushUrl(domain);
  return !!normalized && !!root && normalized === root;
}

function parseUrlParams(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const s = String(raw);
  const q = s.includes("?") ? s.split("?").slice(1).join("?") : s;
  for (const part of q.split(/[&#;]/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = safeDecode(part.slice(0, eq)).trim().toLowerCase();
    const v = safeDecode(part.slice(eq + 1)).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, "%20")); } catch { return s; }
}

async function setSyncState(admin: any, userId: string, siteId: string, status: "success" | "error", error: string | null, rows: number) {
  const now = new Date().toISOString();
  const patch = { last_started_at: now, last_finished_at: now, last_status: status, last_error: error, rows_synced: rows };
  const { data: existing } = await admin
    .from("sync_state")
    .select("id")
    .eq("user_id", userId)
    .eq("source", "gam-sync-push-retention")
    .eq("site_id", siteId)
    .maybeSingle();
  if (existing?.id) {
    await admin.from("sync_state").update(patch).eq("id", existing.id);
  } else {
    await admin.from("sync_state").insert({ user_id: userId, source: "gam-sync-push-retention", site_id: siteId, ...patch });
  }
}

async function getUsdBrlRate(admin: any): Promise<number> {
  const { data } = await admin
    .from("exchange_rates")
    .select("rate")
    .eq("from_currency", "USD")
    .eq("to_currency", "BRL")
    .maybeSingle();
  const rate = Number(data?.rate);
  return Number.isFinite(rate) && rate > 0 ? rate : 5;
}

// ============ GAM Report ============
async function runReport(args: { networkCode: string; accessToken: string; from: string; to: string }): Promise<ReportRow[]> {
  const { networkCode, accessToken, from, to } = args;
  const tag = `${networkCode}/PUSH`;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const all: ReportRow[] = [];
  const runOne = async (
    dimensions: string[],
    sourceDimension: string,
    metrics = ["AD_SERVER_IMPRESSIONS", "AD_SERVER_REVENUE", "AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE", "ADSENSE_IMPRESSIONS", "ADSENSE_REVENUE"],
    options?: { filters?: any[]; forcedRawKv?: string; extraDefinition?: Record<string, unknown> },
  ): Promise<number> => {
    let usableUrlRows = 0;
    const reportDefinition = {
      reportType: "HISTORICAL",
      dimensions,
      metrics,
      ...(options?.filters?.length ? { filters: options.filters } : {}),
      ...(options?.extraDefinition ?? {}),
      dateRange: { fixed: { startDate: { year: fy, month: fm, day: fd }, endDate: { year: ty, month: tm, day: td } } },
    };
    const createRes = await fetch(`${GAM_BASE}/networks/${networkCode}/reports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "DRAFT", reportDefinition }),
    });
    const createText = await createRes.text();
    if (!createRes.ok) throw new Error(`[${tag}/${sourceDimension}] create failed (${createRes.status}): ${createText.slice(0, 400)}`);
    const reportName: string = JSON.parse(createText).name;
    const runRes = await fetch(`${GAM_BASE}/${reportName}:run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const runJson = JSON.parse(await runRes.text());
    if (!runRes.ok) throw new Error(`[${tag}/${sourceDimension}] run failed: ${JSON.stringify(runJson)}`);
    const opName: string = runJson.name;
    let resultName: string | null = null;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const opRes = await fetch(`${GAM_BASE}/${opName}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const opJson = JSON.parse(await opRes.text());
      if (opJson.done) {
        if (opJson.error) throw new Error(`[${tag}/${sourceDimension}] op error: ${JSON.stringify(opJson.error)}`);
        resultName = opJson.response?.reportResult?.name ?? opJson.response?.reportResult ?? opJson.response?.name;
        if (!resultName) throw new Error(`[${tag}/${sourceDimension}] no reportResult`);
        break;
      }
    }
    if (!resultName) throw new Error(`[${tag}/${sourceDimension}] report timeout`);
    let pageToken: string | undefined;
    do {
      const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      url.searchParams.set("pageSize", "1000");
      const rowsRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      const rowsJson = JSON.parse(await rowsRes.text());
      if (!rowsRes.ok) throw new Error(`[${tag}/${sourceDimension}] fetchRows failed: ${JSON.stringify(rowsJson)}`);
      for (const r of (rowsJson.rows ?? [])) {
        const dims = r.dimensionValues ?? [];
        const date = parseGamDate(dims[0]);
        const dimStrings = dims.map((d: any) => {
          if (Array.isArray(d?.stringValues?.values)) return d.stringValues.values.join(";");
          if (Array.isArray(d?.listValue?.values)) return d.listValue.values.map((x: any) => x?.stringValue ?? x?.intValue ?? "").join(";");
          return String(d?.stringValue ?? d?.intValue ?? "");
        });
        const valueFor = (name: string) => {
          const idx = dimensions.indexOf(name);
          return idx >= 0 ? String(dimStrings[idx] ?? "") : "";
        };
        const urlDim = valueFor("PAGE_PATH") || valueFor("URL") || valueFor("CREATIVE_CLICK_THROUGH_URL");
        const kvDim = valueFor("KEY_VALUES_NAME") || valueFor("KEY_VALUES_SET");
        const sourceDimValue = valueFor("EKV_DIMENSION_0_VALUE") || valueFor("CUSTOM_DIMENSION_0_VALUE");
        const rawKv = options?.forcedRawKv
          || kvDim
          || (sourceDimValue ? `utm_source=${sourceDimValue}` : "")
          || (urlDim.includes("?") ? urlDim.split("?").slice(1).join("?").replace(/&/g, ";") : "");
        const m = r.metricValueGroups?.[0]?.primaryValues ?? [];
        const num = (v: any) => Number(v?.intValue ?? v?.doubleValue ?? 0);
        const numRev = (v: any) => v?.intValue != null ? Number(v.intValue) / 1_000_000 : Number(v?.doubleValue ?? 0);
        const impressions = metrics.length === 2 ? num(m[0]) : num(m[0]) + num(m[2]) + num(m[4]);
        const revenue = metrics.length === 2 ? numRev(m[1]) : numRev(m[1]) + numRev(m[3]) + numRev(m[5]);
        if (urlDim && (impressions > 0 || revenue > 0)) usableUrlRows++;
        all.push({ date, url: urlDim, rawKv, impressions, revenue, sourceDimension });
      }
      pageToken = rowsJson.nextPageToken;
    } while (pageToken);
    return usableUrlRows;
  };

  const pushFilter = (dimension: string, value: string) => [{
    fieldFilter: {
      field: { dimension },
      operation: "CONTAINS",
      values: [{ stringValue: value }],
    },
  }];

  // ── Estratégia principal ────────────────────────────────────────────────
  // A GAM Reporting API v1 NÃO permite cruzar PAGE_PATH/URL com KEY_VALUES_NAME
  // no mesmo report (REPORT_ERROR_CONSTRAINTS_INCOMPATIBILITY).
  // A saída suportada é filtrar por CUSTOM_TARGETING_VALUE_ID: pegamos o ID
  // do valor "push" dentro da key "utm_source" e usamos como filter.

  const utmSourceKeyId = await findCustomTargetingKeyId(networkCode, accessToken, "utm_source").catch((e) => {
    console.warn(`[gam-sync-push-retention] customTargetingKeys lookup failed`, e);
    return null;
  });
  const pushValueIds = utmSourceKeyId
    ? await findCustomTargetingValueIds(networkCode, accessToken, utmSourceKeyId, "push").catch((e) => {
        console.warn(`[gam-sync-push-retention] customTargetingValues lookup failed`, e);
        return [] as string[];
      })
    : [];
  console.log(`[gam-sync-push-retention] utm_source keyId=${utmSourceKeyId} pushValueIds=${JSON.stringify(pushValueIds)}`);

  const valueIdFilter = pushValueIds.length
    ? [{
        fieldFilter: {
          // REST v1 expõe key-values como CUSTOM_DIMENSION_* quando a key é
          // informada em customDimensionKeyIds. Para a key 0 (utm_source),
          // o ID do valor fica em CUSTOM_DIMENSION_0_VALUE_ID.
          field: { dimension: "CUSTOM_DIMENSION_0_VALUE_ID" },
          operation: "IN",
          values: pushValueIds.map((id) => ({ intValue: id })),
        },
      }]
    : null;

  if (valueIdFilter) {
    const customDimensionDefinition = { customDimensionKeyIds: [utmSourceKeyId] };
    const runUrlDimension = async (dimension: "PAGE_PATH" | "URL" | "CREATIVE_CLICK_THROUGH_URL", sourceBase: string) => {
      const before = all.length;
      try {
        const usable = await runOne(["DATE", dimension], sourceBase, ["AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE"], {
          filters: valueIdFilter,
          forcedRawKv: "utm_source=push",
          extraDefinition: { expandedCompatibility: true, ...customDimensionDefinition },
        });
        if (usable > 0) return true;
      } catch (e) {
        console.warn(`[gam-sync-push-retention] ${dimension} filtered VALUE_ID failed`, e);
      }
      all.splice(before, all.length - before);
      return false;
    };

    // Tentativa 1: DATE + PAGE_PATH filtrado por customTargetingValueId=push
    if (await runUrlDimension("PAGE_PATH", "PAGE_PATH_FILTERED_VALUE_ID")) return all;

    // Tentativa 2: DATE + URL filtrado por customTargetingValueId=push
    if (await runUrlDimension("URL", "URL_FILTERED_VALUE_ID")) return all;

    // Tentativa 3: DATE + CREATIVE_CLICK_THROUGH_URL filtrado por valueId
    if (await runUrlDimension("CREATIVE_CLICK_THROUGH_URL", "CREATIVE_URL_FILTERED_VALUE_ID")) return all;
  }

  // Fallback final: agregado por DATE + KEY_VALUES_NAME (sem URL) — mantém
  // pelo menos o total de receita push para o card "Receita Push".
  await runOne(["DATE", "KEY_VALUES_NAME"], "KEY_VALUES_NAME", ["AD_EXCHANGE_IMPRESSIONS", "AD_EXCHANGE_REVENUE"]).catch((e) => {
    console.warn(`[gam-sync-push-retention] KEY_VALUES_NAME/AD_EXCHANGE failed`, e);
  });
  await runOne(["DATE", "KEY_VALUES_NAME"], "KEY_VALUES_NAME").catch((e) => {
    console.warn(`[gam-sync-push-retention] KEY_VALUES_NAME failed`, e);
  });

  return all;
}

async function findCustomTargetingValueIds(
  networkCode: string,
  accessToken: string,
  keyId: string,
  wantedValue: string,
): Promise<string[]> {
  const wanted = wantedValue.toLowerCase();
  const keyResourceName = `networks/${networkCode}/customTargetingKeys/${keyId}`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    // No REST v1 do GAM, a coleção de valores fica em nível de network.
    // O vínculo com a key vem pelo campo customTargetingKey, não por uma rota
    // aninhada /customTargetingKeys/{id}/customTargetingValues.
    const url = new URL(`${GAM_BASE}/networks/${networkCode}/customTargetingValues`);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("filter", `customTargetingKey = "${keyResourceName}"`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`customTargetingValues failed (${res.status}): ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    for (const v of (json.customTargetingValues ?? [])) {
      const valueKey = String(v.customTargetingKey ?? "");
      if (valueKey && valueKey !== keyResourceName) continue;
      const adTagName = String(v.adTagName ?? "").toLowerCase();
      const displayName = String(v.displayName ?? "").toLowerCase();
      if (adTagName === wanted || displayName === wanted) {
        const id = String(v.name ?? "").split("/").pop();
        if (id) ids.push(id);
      }
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

async function findCustomTargetingKeyId(networkCode: string, accessToken: string, wantedName: string): Promise<string | null> {
  let pageToken: string | undefined;
  const wanted = wantedName.toLowerCase();
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${GAM_BASE}/networks/${networkCode}/customTargetingKeys`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`customTargetingKeys failed (${res.status}): ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    for (const key of (json.customTargetingKeys ?? [])) {
      const adTagName = String(key.adTagName ?? "").toLowerCase();
      const displayName = String(key.displayName ?? "").toLowerCase();
      const resourceName = String(key.name ?? "");
      if (adTagName === wanted || displayName === wanted || resourceName.toLowerCase().endsWith(`/${wanted}`)) {
        const id = resourceName.split("/").pop();
        if (id) return id;
      }
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return null;
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
