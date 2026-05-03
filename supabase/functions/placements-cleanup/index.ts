// Limpeza global de placements ruins.
// Modos:
//  - preview: lista TODOS placements ruins (com debug por linha)
//  - apply:   adiciona negative placements em cada campanha (apenas WEBSITE)
//  - notify:  cria alerta com resumo (cron diário)
//
// Regras de "ruim":
//  - campanha ENABLED, com >= min_days dias rodando
//  - filtro: cost_brl >= min_cost_brl OU clicks >= min_clicks
//  - ROI <= max_roi_pct (default -10%) — placements sem match UTM contam como ROI -100%
//  - SEM LIMIT, retorna todos
//
// Match UTM:
//  utm_placement = "{campaignid}_{placement}"
//  já vem parseado no GAM em (campaign_id, placement) — fazemos JOIN exato e por raiz.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const REV_SHARE_PCT = 0.32;
const NET_FACTOR = 1 - REV_SHARE_PCT;

interface ApplyItem {
  placement: string;
  type: string;
  campaigns: { campaign_id: string; google_account_id: string }[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const isService = authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "___");
    const body = await req.json().catch(() => ({}));
    const mode: "preview" | "apply" | "notify" = (body?.mode ?? "preview");
    const minDays = Number(body?.min_days ?? 15);
    const minCostBrl = Number(body?.min_cost_brl ?? 20);
    const minClicks = Number(body?.min_clicks ?? 20);
    const maxRoiPct = Number(body?.max_roi_pct ?? -10);
    const fxUsdBrl = Number(body?.fx_usd_brl ?? 5);
    const lookbackDays = Number(body?.lookback_days ?? 15);
    const targetUserId: string | undefined = body?.user_id;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let userId: string | null = null;
    if (isService && targetUserId) {
      userId = targetUserId;
    } else {
      if (!authHeader.startsWith("Bearer ")) return json({ error: "Login obrigatório" });
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
      );
      const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
      userId = claims?.claims?.sub ?? null;
      if (!userId) return json({ error: "Token inválido" });
    }

    const today = new Date();
    const fromDate = new Date(today.getTime() - lookbackDays * 86400_000);
    const cutoffDate = new Date(today.getTime() - minDays * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const from = iso(fromDate);
    const to = iso(today);
    const cutoff = iso(cutoffDate);

    // 1) Campanhas ENABLED
    const { data: camps, error: cErr } = await admin
      .from("campaigns")
      .select("campaign_id, name, status, google_account_id")
      .eq("user_id", userId)
      .eq("status", "enabled");
    if (cErr) return json({ error: cErr.message });
    const campMap = new Map<string, { name: string; google_account_id: string }>();
    for (const c of camps ?? []) {
      if (c.google_account_id) campMap.set(c.campaign_id, { name: c.name, google_account_id: c.google_account_id });
    }
    const campIds = [...campMap.keys()];
    if (campIds.length === 0) return json({ ok: true, items: [], stats: { eligible: 0, total: 0, period: { from, to } } });

    // 2) Filtra por dias rodando: min(date) <= cutoff
    const eligible = new Set<string>();
    for (const chunk of chunkArr(campIds, 200)) {
      const { data } = await admin
        .from("daily_metrics")
        .select("campaign_id, date")
        .eq("user_id", userId)
        .in("campaign_id", chunk)
        .lte("date", cutoff)
        .limit(50000);
      for (const r of data ?? []) eligible.add(r.campaign_id);
    }
    if (eligible.size === 0) {
      return json({ ok: true, items: [], stats: { eligible: 0, total: campIds.length, period: { from, to } } });
    }
    const eligibleIds = [...eligible];

    // 3) ads_placements no período (paginado)
    type AdsRow = { campaign_id: string; placement: string; placement_clean: string | null; placement_type: string | null; cost: number; clicks: number; impressions: number };
    const ads: AdsRow[] = [];
    for (const chunk of chunkArr(eligibleIds, 50)) {
      let start = 0;
      for (;;) {
        const { data, error } = await admin
          .from("ads_placements")
          .select("campaign_id, placement, placement_clean, placement_type, cost, clicks, impressions")
          .eq("user_id", userId)
          .in("campaign_id", chunk)
          .gte("date", from)
          .lte("date", to)
          .range(start, start + 999);
        if (error) return json({ error: error.message });
        const rows = (data ?? []) as AdsRow[];
        ads.push(...rows);
        if (rows.length < 1000) break;
        start += 1000;
      }
    }

    // 4) gam_placement_revenue no período (utm_source=google)
    type GamRow = { campaign_id: string; placement: string; revenue_usd: number };
    const gam: GamRow[] = [];
    for (const chunk of chunkArr(eligibleIds, 50)) {
      let start = 0;
      for (;;) {
        const { data, error } = await admin
          .from("gam_placement_revenue")
          .select("campaign_id, placement, revenue_usd")
          .eq("user_id", userId)
          .eq("utm_source", "google")
          .in("campaign_id", chunk)
          .gte("date", from)
          .lte("date", to)
          .range(start, start + 999);
        if (error) return json({ error: error.message });
        const rows = (data ?? []) as GamRow[];
        gam.push(...rows);
        if (rows.length < 1000) break;
        start += 1000;
      }
    }

    // Receita SOMADA por (campaign_id, placement_normalized) — uma única vez
    const revByCampPlacement = new Map<string, number>();
    for (const g of gam) {
      const key = `${g.campaign_id}|${normalize(g.placement)}`;
      revByCampPlacement.set(key, (revByCampPlacement.get(key) ?? 0) + Number(g.revenue_usd ?? 0));
    }

    // 5) Agrega CUSTO por (campaign_id, placement_clean) — uma única vez por dia,
    //    depois soma a receita CORRESPONDENTE também uma única vez.
    interface CampPl { cost: number; clicks: number; impressions: number; type: string; }
    // costByCampPlacement: campaign_id|placement -> custo agregado
    const cpKey = (cid: string, pl: string) => `${cid}|${pl}`;
    const cpAgg = new Map<string, CampPl>();
    for (const r of ads) {
      const placement = normalize(r.placement_clean || r.placement, r.placement_type);
      if (!placement) continue;
      const k = cpKey(r.campaign_id, placement);
      let c = cpAgg.get(k);
      if (!c) { c = { cost: 0, clicks: 0, impressions: 0, type: r.placement_type ?? "—" }; cpAgg.set(k, c); }
      c.cost += Number(r.cost) || 0;
      c.clicks += Number(r.clicks) || 0;
      c.impressions += Number(r.impressions) || 0;
    }

    // Agrega GLOBAL por placement (somando sobre campanhas)
    interface Agg {
      placement: string;
      type: string;
      costBrl: number;
      clicks: number;
      impressions: number;
      revenueUsd: number;
      hadAnyMatch: boolean;
      campaigns: Map<string, { campaign_id: string; name: string; google_account_id: string; cost: number; revenue_usd: number; matched: boolean }>;
    }
    const aggMap = new Map<string, Agg>();

    for (const [k, v] of cpAgg) {
      const [cid, placement] = k.split("|");
      const meta = campMap.get(cid);
      if (!meta) continue;

      // receita: tenta match exato (cid, placement) e raiz
      const root = rootDomain(placement);
      const usdFull = revByCampPlacement.get(cpKey(cid, placement)) ?? 0;
      const usdRoot = root && root !== placement ? (revByCampPlacement.get(cpKey(cid, root)) ?? 0) : 0;
      const usd = usdFull > 0 ? usdFull : usdRoot;

      let a = aggMap.get(placement);
      if (!a) {
        a = { placement, type: v.type, costBrl: 0, clicks: 0, impressions: 0, revenueUsd: 0, hadAnyMatch: false, campaigns: new Map() };
        aggMap.set(placement, a);
      }
      a.costBrl += v.cost;
      a.clicks += v.clicks;
      a.impressions += v.impressions;
      a.revenueUsd += usd;
      if (usd > 0) a.hadAnyMatch = true;
      a.campaigns.set(cid, {
        campaign_id: cid, name: meta.name, google_account_id: meta.google_account_id,
        cost: v.cost, revenue_usd: usd, matched: usd > 0,
      });
    }

    // 6) Filtra e calcula ROI (sem LIMIT)
    const items = [];
    let skippedSafety = 0;
    for (const a of aggMap.values()) {
      const passSafety = a.costBrl >= minCostBrl || a.clicks >= minClicks;
      if (!passSafety) { skippedSafety++; continue; }
      const revenueBrl = a.revenueUsd * NET_FACTOR * fxUsdBrl;
      const profitBrl = revenueBrl - a.costBrl;
      // Sem match: ROI = -100% (pior caso, conta como ruim)
      const roi = a.costBrl > 0 ? (profitBrl / a.costBrl) * 100 : 0;
      if (roi > maxRoiPct) continue;
      const reason = !a.hadAnyMatch
        ? "sem_match_utm"
        : (roi <= -50 ? "roi_critico" : "roi_baixo");
      items.push({
        placement: a.placement,
        type: a.type,
        cost_brl: round(a.costBrl),
        revenue_brl: round(revenueBrl),
        revenue_usd: round(a.revenueUsd),
        profit_brl: round(profitBrl),
        roi_pct: round(roi),
        clicks: a.clicks,
        impressions: a.impressions,
        match_utm: a.hadAnyMatch,
        reason,
        campaigns: [...a.campaigns.values()].map((c) => ({
          campaign_id: c.campaign_id, name: c.name, google_account_id: c.google_account_id,
          cost_brl: round(c.cost), revenue_usd: round(c.revenue_usd), matched_utm: c.matched,
        })),
      });
    }
    items.sort((x, y) => x.roi_pct - y.roi_pct);

    const stats = {
      eligible: eligibleIds.length,
      total: campIds.length,
      bad: items.length,
      grouped: aggMap.size,
      skipped_safety: skippedSafety,
      ads_rows: ads.length,
      gam_rows: gam.length,
      period: { from, to },
      thresholds: { min_days: minDays, min_cost_brl: minCostBrl, min_clicks: minClicks, max_roi_pct: maxRoiPct },
    };

    if (mode === "preview") return json({ ok: true, items, stats });

    if (mode === "notify") {
      if (items.length > 0) {
        await admin.from("alerts").insert({
          user_id: userId,
          severity: "warning",
          category: "placement_cleanup",
          title: `${items.length} placements ruins detectados`,
          message: `Auto-revisão diária: ${items.length} placements com ROI <= ${maxRoiPct}% em ${eligibleIds.length} campanhas.`,
          metric_snapshot: { items: items.slice(0, 100), stats },
        });
      }
      await admin.from("rules_config").update({ placement_cleanup_last_run_at: new Date().toISOString() }).eq("user_id", userId);
      return json({ ok: true, items, stats, notified: items.length > 0 });
    }

    if (mode === "apply") {
      const selected: ApplyItem[] = (body?.items ?? items.map((i) => ({
        placement: i.placement, type: i.type,
        campaigns: i.campaigns.map((c) => ({ campaign_id: c.campaign_id, google_account_id: c.google_account_id })),
      }))) as ApplyItem[];

      // log de segurança ANTES de aplicar
      const logs = items
        .filter((i) => selected.some((s) => s.placement === i.placement))
        .flatMap((i) => i.campaigns.map((c) => ({
          user_id: userId,
          campaign_id: c.campaign_id,
          placement: i.placement,
          action: "blacklist_preview",
          note: `roi=${i.roi_pct}% cost=${i.cost_brl} rev=${i.revenue_brl} reason=${i.reason}`,
        })));
      if (logs.length) await admin.from("placement_actions").insert(logs);

      const result = await applyNegativePlacements(admin, userId, selected);
      return json({ ok: true, applied: result.applied, failed: result.failed, details: result.details, stats });
    }

    return json({ error: "mode inválido" });
  } catch (e) {
    console.error("[placements-cleanup]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});

function chunkArr<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalize(value: string, type?: string | null): string {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "";
  const m = raw.match(/mobileapp::\d+-(.+)$/i);
  if (m) return m[1].replace(/^www\./, "");
  if (type === "MOBILE_APPLICATION") {
    const n = raw.match(/^\d+-(.+)$/);
    if (n) return n[1].replace(/^www\./, "");
  }
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^www\./, "");
  }
}

function rootDomain(host: string): string {
  if (!host || host.includes("/") || !host.includes(".")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  const cc = new Set(["com.br", "co.uk", "com.au", "com.mx", "co.jp", "com.ar", "co.in"]);
  if (cc.has(last2) && parts.length >= 3) return parts.slice(-3).join(".");
  return last2;
}

function round(n: number) { return Math.round(n * 100) / 100; }

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function applyNegativePlacements(admin: any, userId: string, items: ApplyItem[]) {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
  const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;
  const accountIds = [...new Set(items.flatMap((i) => i.campaigns.map((c) => c.google_account_id)))];
  const { data: accs } = await admin
    .from("google_accounts")
    .select("id, customer_id, refresh_token, login_customer_id")
    .in("id", accountIds);
  const accMap = new Map<string, any>();
  const tokenCache = new Map<string, string>();
  for (const a of accs ?? []) accMap.set(a.id, a);

  async function getToken(refresh: string) {
    if (tokenCache.has(refresh)) return tokenCache.get(refresh)!;
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
    tokenCache.set(refresh, j.access_token);
    return j.access_token as string;
  }

  const ops = new Map<string, { acc: any; campaign_id: string; placements: { placement: string; type: string }[] }>();
  for (const it of items) {
    if (it.type !== "WEBSITE") continue;
    for (const c of it.campaigns) {
      const acc = accMap.get(c.google_account_id);
      if (!acc?.refresh_token) continue;
      const k = `${c.google_account_id}|${c.campaign_id}`;
      let g = ops.get(k);
      if (!g) { g = { acc, campaign_id: c.campaign_id, placements: [] }; ops.set(k, g); }
      g.placements.push({ placement: it.placement, type: it.type });
    }
  }

  const details: any[] = [];
  let applied = 0, failed = 0;

  for (const g of ops.values()) {
    try {
      const token = await getToken(g.acc.refresh_token);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "developer-token": devToken,
        "Content-Type": "application/json",
      };
      if (g.acc.login_customer_id) headers["login-customer-id"] = g.acc.login_customer_id;
      const operations = g.placements.map((p) => ({
        create: {
          campaign: `customers/${g.acc.customer_id}/campaigns/${g.campaign_id}`,
          negative: true,
          placement: { url: p.placement.startsWith("http") ? p.placement : `https://${p.placement}` },
        },
      }));
      const r = await fetch(
        `https://googleads.googleapis.com/v21/customers/${g.acc.customer_id}/campaignCriteria:mutate`,
        { method: "POST", headers, body: JSON.stringify({ operations, partialFailure: true }) },
      );
      const j = await r.json();
      if (!r.ok) {
        failed += g.placements.length;
        details.push({ campaign_id: g.campaign_id, error: j?.error?.message ?? JSON.stringify(j) });
        await admin.from("automation_actions").insert({
          user_id: userId, campaign_id: g.campaign_id, action_type: "negative_placement",
          payload: { placements: g.placements }, status: "failed", error: JSON.stringify(j), executed_at: new Date().toISOString(),
        });
        continue;
      }
      applied += g.placements.length;
      details.push({ campaign_id: g.campaign_id, count: g.placements.length, partial: j?.partialFailureError ?? null });
      const inserts = g.placements.map((p) => ({
        user_id: userId, campaign_id: g.campaign_id, placement: p.placement,
        action: "blacklist", note: "global cleanup applied",
      }));
      if (inserts.length) await admin.from("placement_actions").insert(inserts);
      await admin.from("automation_actions").insert({
        user_id: userId, campaign_id: g.campaign_id, action_type: "negative_placement",
        payload: { placements: g.placements, partial: j?.partialFailureError ?? null },
        status: "executed", executed_at: new Date().toISOString(),
      });
    } catch (e) {
      failed += g.placements.length;
      details.push({ campaign_id: g.campaign_id, error: String(e instanceof Error ? e.message : e) });
    }
  }
  return { applied, failed, details };
}
