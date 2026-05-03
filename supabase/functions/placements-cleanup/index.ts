// Limpeza global de placements ruins.
// Modos:
//  - preview: calcula placements ruins agregados em TODAS as campanhas elegíveis
//  - apply:   adiciona negative placements em cada campanha onde o ruim aparece
//  - notify:  cria um alerta com o resumo (usado pelo cron)
//
// Regras:
//  - campanha precisa estar ENABLED e ter >= 20 dias de histórico em daily_metrics
//  - filtro de segurança: custo_total_brl >= min_cost_brl OU cliques_total >= min_clicks
//  - precisa ter match UTM (utm_full / utm_root) no GAM
//  - marca como ruim se ROI <= max_roi_pct (default -10%)
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
    const minDays = Number(body?.min_days ?? 20);
    const minCostBrl = Number(body?.min_cost_brl ?? 50); // ~ $10 * 5
    const minClicks = Number(body?.min_clicks ?? 100);
    const maxRoiPct = Number(body?.max_roi_pct ?? -10);
    const fxUsdBrl = Number(body?.fx_usd_brl ?? 5);
    const lookbackDays = Number(body?.lookback_days ?? 30);
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

    // 1) Campanhas ENABLED do usuário
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
    if (campIds.length === 0) return json({ ok: true, items: [], stats: { eligible: 0, total: 0 } });

    // 2) Filtra por dias rodando: min(date) <= cutoff
    const eligible = new Set<string>();
    // Busca min date por campanha em chunks
    const chunks: string[][] = [];
    for (let i = 0; i < campIds.length; i += 200) chunks.push(campIds.slice(i, i + 200));
    for (const chunk of chunks) {
      const { data } = await admin
        .from("daily_metrics")
        .select("campaign_id, date")
        .eq("user_id", userId)
        .in("campaign_id", chunk)
        .order("date", { ascending: true })
        .limit(10000);
      const minBy = new Map<string, string>();
      for (const r of data ?? []) {
        const cur = minBy.get(r.campaign_id);
        if (!cur || r.date < cur) minBy.set(r.campaign_id, r.date);
      }
      for (const [cid, d] of minBy) if (d <= cutoff) eligible.add(cid);
    }
    if (eligible.size === 0) {
      return json({ ok: true, items: [], stats: { eligible: 0, total: campIds.length } });
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

    // Receita por (campaign_id, placement_normalized)
    const revByCampPlacement = new Map<string, number>();
    for (const g of gam) {
      const k = `${g.campaign_id}|${normalize(g.placement)}`;
      revByCampPlacement.set(k, (revByCampPlacement.get(k) ?? 0) + Number(g.revenue_usd ?? 0));
    }

    // 5) Agrega global por placement_clean
    interface Agg {
      placement: string;
      type: string;
      costBrl: number;
      clicks: number;
      impressions: number;
      revenueUsd: number;
      campaigns: Map<string, { campaign_id: string; name: string; google_account_id: string; cost: number; matched: boolean }>;
    }
    const aggMap = new Map<string, Agg>();
    for (const r of ads) {
      const key = normalize(r.placement_clean || r.placement, r.placement_type);
      if (!key) continue;
      let a = aggMap.get(key);
      if (!a) {
        a = { placement: key, type: r.placement_type ?? "—", costBrl: 0, clicks: 0, impressions: 0, revenueUsd: 0, campaigns: new Map() };
        aggMap.set(key, a);
      }
      a.costBrl += Number(r.cost) || 0;
      a.clicks += Number(r.clicks) || 0;
      a.impressions += Number(r.impressions) || 0;

      // attribution per campaign
      const root = rootDomain(key);
      const usdFull = revByCampPlacement.get(`${r.campaign_id}|${key}`) ?? 0;
      const usdRoot = root && root !== key ? (revByCampPlacement.get(`${r.campaign_id}|${root}`) ?? 0) : 0;
      const usd = usdFull > 0 ? usdFull : usdRoot;
      a.revenueUsd += usd;

      const meta = campMap.get(r.campaign_id);
      if (meta) {
        const cur = a.campaigns.get(r.campaign_id);
        if (!cur) {
          a.campaigns.set(r.campaign_id, { campaign_id: r.campaign_id, name: meta.name, google_account_id: meta.google_account_id, cost: Number(r.cost) || 0, matched: usd > 0 });
        } else {
          cur.cost += Number(r.cost) || 0;
          cur.matched = cur.matched || usd > 0;
        }
      }
    }

    // 6) Aplica filtros e calcula ROI
    const items = [];
    for (const a of aggMap.values()) {
      const passSafety = a.costBrl >= minCostBrl || a.clicks >= minClicks;
      if (!passSafety) continue;
      if (a.revenueUsd <= 0) continue; // sem match UTM = ignora
      const revenueBrl = a.revenueUsd * NET_FACTOR * fxUsdBrl;
      const profitBrl = revenueBrl - a.costBrl;
      const roi = a.costBrl > 0 ? (profitBrl / a.costBrl) * 100 : 0;
      if (roi > maxRoiPct) continue; // só ruins
      items.push({
        placement: a.placement,
        type: a.type,
        cost_brl: round(a.costBrl),
        revenue_brl: round(revenueBrl),
        profit_brl: round(profitBrl),
        roi_pct: round(roi),
        clicks: a.clicks,
        impressions: a.impressions,
        campaigns: [...a.campaigns.values()].map((c) => ({
          campaign_id: c.campaign_id, name: c.name, google_account_id: c.google_account_id,
          cost_brl: round(c.cost), matched_utm: c.matched,
        })),
      });
    }
    items.sort((a, b) => a.roi_pct - b.roi_pct);

    const stats = { eligible: eligibleIds.length, total: campIds.length, bad: items.length, period: { from, to } };

    if (mode === "preview") {
      return json({ ok: true, items, stats });
    }

    if (mode === "notify") {
      if (items.length > 0) {
        await admin.from("alerts").insert({
          user_id: userId,
          severity: "warning",
          category: "placement_cleanup",
          title: `${items.length} placements ruins detectados`,
          message: `Revisão automática (${minDays}d): ${items.length} placements com ROI <= ${maxRoiPct}% em ${eligibleIds.length} campanhas.`,
          metric_snapshot: { items: items.slice(0, 50), stats },
        });
      }
      return json({ ok: true, items, stats, notified: items.length > 0 });
    }

    if (mode === "apply") {
      const selected: ApplyItem[] = (body?.items ?? items.map((i) => ({
        placement: i.placement, type: i.type, campaigns: i.campaigns.map((c) => ({ campaign_id: c.campaign_id, google_account_id: c.google_account_id })),
      }))) as ApplyItem[];
      const result = await applyNegativePlacements(admin, userId, selected);
      return json({ ok: true, applied: result.applied, failed: result.failed, details: result.details });
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

// === Aplicação no Google Ads ===
// Cria negative placement criteria por campanha. Suporta WEBSITE; pula MOBILE_APPLICATION e YouTube por segurança.
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

  // Agrupa por (campaign_id, account_id)
  const ops = new Map<string, { acc: any; campaign_id: string; placements: { placement: string; type: string }[] }>();
  for (const it of items) {
    if (it.type !== "WEBSITE") continue; // segurança
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
      // registra ações
      const inserts = g.placements.map((p) => ({
        user_id: userId, campaign_id: g.campaign_id, placement: p.placement,
        action: "blacklist", note: "global cleanup",
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
