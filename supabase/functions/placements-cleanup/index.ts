// Limpeza global de placements ruins.
// Preview calcula placements ao vivo no Google Ads para o período completo, agrupando por campanha + placement.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const REV_SHARE_PCT = 0.32;
const NET_FACTOR = 1 - REV_SHARE_PCT;
const KEY_SEP = "\u0001";

interface ApplyCampaign {
  campaign_id: string;
  google_account_id: string;
  cost_brl?: number;
  revenue_usd?: number;
  roi_pct?: number;
}

interface ApplyItem {
  key?: string;
  placement: string;
  type: string;
  app_id?: string | null;
  cost_brl?: number;
  revenue_brl?: number;
  revenue_usd?: number;
  roi_pct?: number;
  reason?: string;
  campaigns: ApplyCampaign[];
}

type CampMeta = { name: string; google_account_id: string };
type LiveAdsRow = {
  google_account_id: string;
  campaign_id: string;
  placement: string;
  placement_clean: string | null;
  placement_type: string | null;
  app_id: string | null; // ex.: "1-com.whatsapp" (Android) ou "2-123456789" (iOS)
  cost: number;
  clicks: number;
  impressions: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const isService = authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "___");
    const body = await req.json().catch(() => ({}));
    const mode: "preview" | "apply" | "notify" = body?.mode ?? "preview";
    const minDays = Math.max(1, Number(body?.min_days ?? 15));
    const minCostBrl = Math.max(0, Number(body?.min_cost_brl ?? 20));
    const maxRoiPct = Number(body?.max_roi_pct ?? -10);
    const fxUsdBrl = Number(body?.fx_usd_brl ?? 5);
    const lookbackDays = Math.max(1, Number(body?.lookback_days ?? 15));
    const targetUserId: string | undefined = body?.user_id;
    const siteId: string | null = typeof body?.site_id === "string" && body.site_id && body.site_id !== "all" ? body.site_id : null;
    const accountIds: string[] = Array.isArray(body?.google_account_ids)
      ? body.google_account_ids.map((x: unknown) => String(x)).filter(Boolean)
      : [];

    // Quando vier do client (não do cron interno), exigimos site_id para evitar afetar outros sites.
    const isCron = isService && !!targetUserId;
    if (!isCron && !siteId) {
      return json({ error: "Site obrigatório: selecione um site antes de rodar a limpeza global." });
    }

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

    // Janela alinhada com o preset "Últimos 15 dias" do dashboard:
    // de (hoje - lookback) até ontem (último dia completo no Google Ads).
    const today = new Date();
    const toDate = new Date(today.getTime() - 86400_000); // ontem
    const fromDate = new Date(today.getTime() - lookbackDays * 86400_000);
    const cutoffDate = new Date(today.getTime() - minDays * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const from = iso(fromDate);
    const to = iso(toDate);
    const cutoff = iso(cutoffDate);

    // Restringe contas Ads ao escopo do site selecionado.
    let allowedAccountIds: string[] | null = null;
    if (siteId) {
      const { data: links, error: linkErr } = await admin
        .from("account_site_links")
        .select("google_account_id")
        .eq("user_id", userId)
        .eq("site_id", siteId);
      if (linkErr) return json({ error: linkErr.message });
      allowedAccountIds = [...new Set((links ?? []).map((l) => String(l.google_account_id)))];
      if (allowedAccountIds.length === 0) {
        return json({ ok: true, items: [], stats: { eligible: 0, total: 0, period: { from, to } }, info: "Nenhuma conta Ads vinculada ao site." });
      }
    } else if (accountIds.length > 0) {
      allowedAccountIds = accountIds;
    }

    let campsQuery = admin
      .from("campaigns")
      .select("campaign_id, name, status, google_account_id")
      .eq("user_id", userId)
      .eq("status", "enabled");
    if (allowedAccountIds) campsQuery = campsQuery.in("google_account_id", allowedAccountIds);
    const { data: camps, error: cErr } = await campsQuery;
    if (cErr) return json({ error: cErr.message });

    const campMap = new Map<string, CampMeta>();
    for (const c of camps ?? []) {
      if (c.google_account_id) campMap.set(String(c.campaign_id), { name: c.name, google_account_id: c.google_account_id });
    }
    const campIds = [...campMap.keys()];
    if (campIds.length === 0) return json({ ok: true, items: [], stats: { eligible: 0, total: 0, period: { from, to } } });

    const eligible = new Set<string>();
    for (const chunk of chunkArr(campIds, 200)) {
      const { data, error } = await admin
        .from("daily_metrics")
        .select("campaign_id, date")
        .eq("user_id", userId)
        .in("campaign_id", chunk)
        .lte("date", cutoff)
        .limit(50000);
      if (error) return json({ error: error.message });
      for (const r of data ?? []) eligible.add(String(r.campaign_id));
    }
    if (eligible.size === 0) {
      return json({ ok: true, items: [], stats: { eligible: 0, total: campIds.length, period: { from, to } } });
    }
    const eligibleIds = [...eligible];

    const ads = await fetchLiveAdsPlacements(admin, userId, eligibleIds, campMap, from, to);

    type GamRow = { campaign_id: string; placement: string; revenue_usd: number };
    const gam: GamRow[] = [];
    for (const chunk of chunkArr(eligibleIds, 50)) {
      let start = 0;
      for (;;) {
        // CRÍTICO multi-site: filtrar por site_id quando definido para não misturar
        // receita de outros sites que usem a mesma conta Ads.
        let gamQuery = admin
          .from("gam_placement_revenue")
          .select("campaign_id, placement, revenue_usd")
          .eq("user_id", userId)
          .in("campaign_id", chunk)
          .gte("date", from)
          .lte("date", to);
        if (siteId) gamQuery = gamQuery.eq("site_id", siteId);
        const { data, error } = await gamQuery.range(start, start + 999);
        if (error) return json({ error: error.message });
        const rows = (data ?? []) as GamRow[];
        gam.push(...rows);
        if (rows.length < 1000) break;
        start += 1000;
      }
    }

    // Agrupa receita GAM por (campaign, placement-normalizado)
    const revByCampaign = new Map<string, Map<string, number>>();
    for (const g of gam) {
      const placement = normalize(g.placement);
      if (!placement) continue;
      const cid = String(g.campaign_id);
      const inner = revByCampaign.get(cid) ?? new Map<string, number>();
      inner.set(placement, (inner.get(placement) ?? 0) + Number(g.revenue_usd ?? 0));
      revByCampaign.set(cid, inner);
    }

    // Placements já excluídos não devem voltar no próximo preview/limpeza.
    // A marcação é por campanha, porque o mesmo domínio pode ser ruim em uma campanha
    // e ainda não ter sido excluído em outra.
    const blacklisted = new Set<string>();
    for (const chunk of chunkArr(eligibleIds, 200)) {
      let start = 0;
      for (;;) {
        const { data, error } = await admin
          .from("placement_actions")
          .select("campaign_id, placement")
          .eq("user_id", userId)
          .eq("action", "blacklist")
          .in("campaign_id", chunk)
          .range(start, start + 999);
        if (error) return json({ error: error.message });
        const rows = data ?? [];
        for (const r of rows) {
          const placement = normalize(String(r.placement ?? ""));
          if (r.campaign_id && placement) blacklisted.add(cpKey(String(r.campaign_id), placement));
        }
        if (rows.length < 1000) break;
        start += 1000;
      }
    }

    interface CampPl { campaign_id: string; placement: string; cost: number; clicks: number; impressions: number; type: string; app_id: string | null; }
    const cpAgg = new Map<string, CampPl>();
    for (const r of ads) {
      const placement = normalize(r.placement_clean || r.placement, r.placement_type);
      if (!placement) continue;
      const k = cpKey(r.campaign_id, placement);
      let c = cpAgg.get(k);
      if (!c) {
        c = { campaign_id: r.campaign_id, placement, cost: 0, clicks: 0, impressions: 0, type: r.placement_type ?? "—", app_id: r.app_id };
        cpAgg.set(k, c);
      }
      c.cost += Number(r.cost) || 0;
      c.clicks += Number(r.clicks) || 0;
      c.impressions += Number(r.impressions) || 0;
      if (r.placement_type) c.type = r.placement_type;
      if (!c.app_id && r.app_id) c.app_id = r.app_id;
    }

    // Aloca receita GAM aos placements Ads — exato → root → prefixo compactado;
    // sobra distribui proporcional ao custo (fallback "campanha").
    type AdsAgg = { campaign_id: string; placement: string; cost: number; clicks: number };
    const adsByCampaign = new Map<string, AdsAgg[]>();
    for (const v of cpAgg.values()) {
      const list = adsByCampaign.get(v.campaign_id) ?? [];
      list.push({ campaign_id: v.campaign_id, placement: v.placement, cost: v.cost, clicks: v.clicks });
      adsByCampaign.set(v.campaign_id, list);
    }
    const revenueUsdByCp = new Map<string, number>();
    let totalGamUsd = 0;
    let attributedGamUsd = 0;
    for (const [cid, revenues] of revByCampaign) {
      const ads = adsByCampaign.get(cid) ?? [];
      for (const usd of revenues.values()) totalGamUsd += usd;
      if (ads.length === 0) continue;
      const indexes = buildPlacementIndexes(ads);
      const claimed = new Set<string>();
      let unmatchedUsd = 0;
      for (const [rawPlacement, usd] of revenues) {
        if (usd <= 0) continue;
        const matches = findPlacementMatches(normalize(rawPlacement), indexes).filter((a) => !claimed.has(a.placement));
        if (matches.length === 0) { unmatchedUsd += usd; continue; }
        const totalCost = matches.reduce((sum, a) => sum + Math.max(0, a.cost), 0);
        const totalClicks = matches.reduce((sum, a) => sum + Math.max(0, a.clicks), 0);
        const equalShare = usd / matches.length;
        for (const a of matches) {
          const weight = totalCost > 0 ? Math.max(0, a.cost) / totalCost : totalClicks > 0 ? Math.max(0, a.clicks) / totalClicks : 0;
          const share = weight > 0 ? usd * weight : equalShare;
          const key = cpKey(cid, a.placement);
          revenueUsdByCp.set(key, (revenueUsdByCp.get(key) ?? 0) + share);
          attributedGamUsd += share;
          claimed.add(a.placement);
        }
      }
      if (unmatchedUsd > 0) {
        // Fallback: distribui proporcional ao custo entre placements ainda sem match
        const targets = ads.filter((a) => !claimed.has(a.placement));
        const fallback = targets.length > 0 ? targets : ads;
        const totalCost = fallback.reduce((sum, a) => sum + Math.max(0, a.cost), 0);
        const totalClicks = fallback.reduce((sum, a) => sum + Math.max(0, a.clicks), 0);
        const equalShare = unmatchedUsd / fallback.length;
        for (const a of fallback) {
          const weight = totalCost > 0 ? Math.max(0, a.cost) / totalCost : totalClicks > 0 ? Math.max(0, a.clicks) / totalClicks : 0;
          const share = weight > 0 ? unmatchedUsd * weight : equalShare;
          const key = cpKey(cid, a.placement);
          revenueUsdByCp.set(key, (revenueUsdByCp.get(key) ?? 0) + share);
          attributedGamUsd += share;
        }
      }
    }

    const items = [];
    let skippedSafety = 0;
    let skippedAlreadyBlacklisted = 0;
    let withMatch = 0, withoutMatch = 0;
    for (const v of cpAgg.values()) {
      const meta = campMap.get(v.campaign_id);
      if (!meta) continue;
      if (blacklisted.has(cpKey(v.campaign_id, normalize(v.placement, v.type)))) {
        skippedAlreadyBlacklisted++;
        continue;
      }
      if (v.cost < minCostBrl) { skippedSafety++; continue; }

      const revenueUsd = revenueUsdByCp.get(cpKey(v.campaign_id, v.placement)) ?? 0;
      // "matched" = teve algum match real (exato/root/prefixo) — checa se houve receita direta
      const directUsd = revByCampaign.get(v.campaign_id)?.get(v.placement) ?? 0;
      const rootUsd = revByCampaign.get(v.campaign_id)?.get(rootDomain(v.placement)) ?? 0;
      const matched = directUsd > 0 || rootUsd > 0 || revenueUsd > 0;
      if (matched) withMatch++; else withoutMatch++;
      const revenueBrl = revenueUsd * NET_FACTOR * fxUsdBrl;
      const profitBrl = revenueBrl - v.cost;
      const roi = v.cost > 0 ? (profitBrl / v.cost) * 100 : 0;
      if (roi > maxRoiPct) continue;

      const reason = !matched ? "sem_match_utm" : (roi <= -50 ? "roi_critico" : "roi_baixo");
      const itemKey = `${v.campaign_id}|${v.placement}`;
      items.push({
        key: itemKey,
        placement: v.placement,
        type: v.type,
        app_id: v.app_id,
        cost_brl: round(v.cost),
        revenue_brl: round(revenueBrl),
        revenue_usd: round(revenueUsd),
        profit_brl: round(profitBrl),
        roi_pct: round(roi),
        clicks: v.clicks,
        impressions: v.impressions,
        match_utm: matched,
        reason,
        campaigns: [{
          campaign_id: v.campaign_id,
          name: meta.name,
          google_account_id: meta.google_account_id,
          cost_brl: round(v.cost),
          revenue_usd: round(revenueUsd),
          matched_utm: matched,
          roi_pct: round(roi),
        }],
      });
    }
    items.sort((x, y) => x.roi_pct - y.roi_pct || y.cost_brl - x.cost_brl);

    type CampTotal = { campaign_id: string; name: string; google_account_id: string; cost_brl: number; revenue_brl: number; profit_brl: number; roi_pct: number; bad_count: number; eligible: boolean };
    const totalsMap = new Map<string, CampTotal>();
    // IMPORTANTE: somar custo/receita de TODAS as campanhas ENABLED (campIds),
    // não só as elegíveis para limpeza. Assim o header bate com o dashboard.
    for (const chunk of chunkArr(campIds, 200)) {
      const { data, error } = await admin
        .from("daily_metrics")
        .select("campaign_id, spend, revenue")
        .eq("user_id", userId)
        .in("campaign_id", chunk)
        .gte("date", from)
        .lte("date", to)
        .limit(50000);
      if (error) return json({ error: error.message });
      for (const r of data ?? []) {
        const meta = campMap.get(String(r.campaign_id));
        if (!meta) continue;
        let t = totalsMap.get(String(r.campaign_id));
        if (!t) {
          t = { campaign_id: String(r.campaign_id), name: meta.name, google_account_id: meta.google_account_id, cost_brl: 0, revenue_brl: 0, profit_brl: 0, roi_pct: 0, bad_count: 0, eligible: eligible.has(String(r.campaign_id)) };
          totalsMap.set(String(r.campaign_id), t);
        }
        t.cost_brl += Number(r.spend) || 0;
        t.revenue_brl += (Number(r.revenue) || 0) * NET_FACTOR * fxUsdBrl;
      }
    }
    for (const id of campIds) {
      const meta = campMap.get(id);
      if (meta && !totalsMap.has(id)) totalsMap.set(id, { campaign_id: id, name: meta.name, google_account_id: meta.google_account_id, cost_brl: 0, revenue_brl: 0, profit_brl: 0, roi_pct: 0, bad_count: 0, eligible: eligible.has(id) });
    }
    for (const t of totalsMap.values()) {
      t.profit_brl = t.revenue_brl - t.cost_brl;
      t.roi_pct = t.cost_brl > 0 ? (t.profit_brl / t.cost_brl) * 100 : 0;
      t.cost_brl = round(t.cost_brl);
      t.revenue_brl = round(t.revenue_brl);
      t.profit_brl = round(t.profit_brl);
      t.roi_pct = round(t.roi_pct);
    }
    for (const it of items) {
      const cid = it.campaigns[0]?.campaign_id;
      const t = cid ? totalsMap.get(cid) : null;
      if (t) t.bad_count++;
    }

    const campaign_totals = [...totalsMap.values()];
    const grand_cost_brl = round(campaign_totals.reduce((a, c) => a + c.cost_brl, 0));
    const grand_revenue_brl = round(campaign_totals.reduce((a, c) => a + c.revenue_brl, 0));
    const grand_profit_brl = round(grand_revenue_brl - grand_cost_brl);

    const totalAnalyzed = withMatch + withoutMatch;
    const stats = {
      eligible: eligibleIds.length,
      total: campIds.length,
      bad: items.length,
      grouped: cpAgg.size,
      skipped_safety: skippedSafety,
      skipped_blacklisted: skippedAlreadyBlacklisted,
      ads_rows: ads.length,
      gam_rows: gam.length,
      with_match: withMatch,
      without_match: withoutMatch,
      match_pct: totalAnalyzed > 0 ? round((withMatch / totalAnalyzed) * 100) : 0,
      gam_total_usd: round(totalGamUsd),
      gam_attributed_usd: round(attributedGamUsd),
      gam_attributed_pct: totalGamUsd > 0 ? round((attributedGamUsd / totalGamUsd) * 100) : 0,
      period: { from, to },
      source: "google_ads_api_live",
      thresholds: { min_days: minDays, min_cost_brl: minCostBrl, max_roi_pct: maxRoiPct },
      grand_cost_brl,
      grand_revenue_brl,
      grand_profit_brl,
    };

    if (mode === "preview") return json({ ok: true, items, stats, campaign_totals });

    if (mode === "notify") {
      if (items.length > 0) {
        await admin.from("alerts").insert({
          user_id: userId,
          severity: "warning",
          category: "placement_cleanup",
          title: `${items.length} placements ruins detectados`,
          message: `Auto-revisão 15d: ${items.length} placements com ROI <= ${maxRoiPct}% em ${eligibleIds.length} campanhas.`,
          metric_snapshot: { items: items.slice(0, 100), stats },
        });
      }
      await admin.from("rules_config").update({ placement_cleanup_last_run_at: new Date().toISOString() }).eq("user_id", userId);
      return json({ ok: true, items, stats, notified: items.length > 0 });
    }

    if (mode === "apply") {
      const selected: ApplyItem[] = Array.isArray(body?.items) && body.items.length
        ? body.items as ApplyItem[]
        : items.map((i) => ({
          key: i.key,
          placement: i.placement,
          type: i.type,
          app_id: i.app_id ?? null,
          cost_brl: i.cost_brl,
          revenue_brl: i.revenue_brl,
          revenue_usd: i.revenue_usd,
          roi_pct: i.roi_pct,
          reason: i.reason,
          campaigns: i.campaigns.map((c) => ({
            campaign_id: c.campaign_id,
            google_account_id: c.google_account_id,
            cost_brl: c.cost_brl,
            revenue_usd: c.revenue_usd,
            roi_pct: c.roi_pct,
          })),
        }));

      const result = await applyNegativePlacements(admin, userId, selected);

      // Registra log de impacto por campanha (snapshot ROI antes + qtd removida)
      try {
        const perCampaign = new Map<string, { count: number; placements: string[] }>();
        for (const d of result.details ?? []) {
          if (!d?.campaign_id || !d?.count) continue;
          const cur = perCampaign.get(String(d.campaign_id)) ?? { count: 0, placements: [] };
          cur.count += Number(d.count) || 0;
          perCampaign.set(String(d.campaign_id), cur);
        }
        // Coleta nomes de placements aplicados por campanha (a partir do payload original)
        for (const it of selected) {
          for (const c of it.campaigns) {
            const cur = perCampaign.get(String(c.campaign_id));
            if (cur && !cur.placements.includes(it.placement)) cur.placements.push(it.placement);
          }
        }
        const logs = [];
        for (const [cid, info] of perCampaign) {
          if (info.count <= 0) continue;
          const meta = campMap.get(cid);
          const totals = totalsMap.get(cid);
          logs.push({
            user_id: userId,
            site_id: siteId,
            google_account_id: meta?.google_account_id ?? null,
            campaign_id: cid,
            campaign_name: meta?.name ?? null,
            placements_removed_count: info.count,
            removed_placements: info.placements,
            roi_before: totals?.roi_pct ?? null,
            cost_before: totals?.cost_brl ?? null,
            revenue_before: totals?.revenue_brl ?? null,
            lookback_days: lookbackDays,
            executed_at: new Date().toISOString(),
          });
        }
        if (logs.length) await admin.from("placement_cleanup_logs").insert(logs);
      } catch (e) {
        console.error("[placements-cleanup] log impact error", e);
      }

      return json({ ok: true, applied: result.applied, failed: result.failed, details: result.details, stats });
    }

    return json({ error: "mode inválido" });
  } catch (e) {
    console.error("[placements-cleanup]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});

async function fetchLiveAdsPlacements(
  admin: any,
  userId: string,
  eligibleIds: string[],
  campMap: Map<string, CampMeta>,
  from: string,
  to: string,
): Promise<LiveAdsRow[]> {
  const byAccount = new Map<string, string[]>();
  for (const cid of eligibleIds) {
    const accId = campMap.get(cid)?.google_account_id;
    if (!accId) continue;
    const arr = byAccount.get(accId) ?? [];
    arr.push(cid);
    byAccount.set(accId, arr);
  }

  const { data: accs, error } = await admin
    .from("google_accounts")
    .select("id, customer_id, refresh_token, login_customer_id")
    .eq("user_id", userId)
    .in("id", [...byAccount.keys()]);
  if (error) throw new Error(error.message);

  const accMap = new Map<string, any>();
  for (const a of accs ?? []) accMap.set(a.id, a);

  const tokenCache = new Map<string, string>();
  const out: LiveAdsRow[] = [];

  for (const [accountId, campaignIds] of byAccount) {
    const acc = accMap.get(accountId);
    if (!acc?.refresh_token || !acc?.customer_id) continue;
    const token = await getGoogleToken(acc.refresh_token, tokenCache);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
      "Content-Type": "application/json",
    };
    if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;

    for (const chunk of chunkArr(campaignIds, 50)) {
      const idList = chunk.map((id) => String(id).replace(/\D/g, "")).filter(Boolean).join(",");
      if (!idList) continue;
      const query = `
        SELECT
          detail_placement_view.placement,
          detail_placement_view.display_name,
          detail_placement_view.target_url,
          detail_placement_view.placement_type,
          detail_placement_view.group_placement_target_url,
          campaign.id,
          campaign.name,
          metrics.clicks,
          metrics.impressions,
          metrics.cost_micros
        FROM detail_placement_view
        WHERE segments.date BETWEEN '${from}' AND '${to}'
          AND campaign.id IN (${idList})
          AND metrics.cost_micros > 0
      `;

      let pageToken: string | undefined;
      do {
        const res = await fetch(
          `https://googleads.googleapis.com/v21/customers/${acc.customer_id}/googleAds:search`,
          { method: "POST", headers, body: JSON.stringify({ query, pageToken }) },
        );
        const data = await res.json();
        if (!res.ok) {
          console.error("[placements-cleanup] live GAQL error", JSON.stringify(data));
          throw new Error(data?.error?.message ?? "Erro ao buscar placements no Google Ads");
        }
        for (const r of data.results ?? []) {
          const placementRaw = String(r.detailPlacementView?.placement ?? r.detailPlacementView?.displayName ?? "unknown");
          const targetUrl = r.detailPlacementView?.targetUrl ?? r.detailPlacementView?.groupPlacementTargetUrl ?? null;
          const type = r.detailPlacementView?.placementType ?? null;
          out.push({
            google_account_id: accountId,
            campaign_id: String(r.campaign?.id ?? ""),
            placement: placementRaw,
            placement_clean: cleanPlacement(placementRaw, targetUrl, type),
            placement_type: type,
            app_id: extractAppId(placementRaw, type),
            cost: Number(r.metrics?.costMicros ?? 0) / 1_000_000,
            clicks: Number(r.metrics?.clicks ?? 0),
            impressions: Number(r.metrics?.impressions ?? 0),
          });
        }
        pageToken = data.nextPageToken || undefined;
      } while (pageToken);
    }
  }

  return out;
}

async function getGoogleToken(refreshToken: string, cache: Map<string, string>) {
  if (cache.has(refreshToken)) return cache.get(refreshToken)!;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
  cache.set(refreshToken, j.access_token);
  return j.access_token as string;
}

function cpKey(cid: string, placement: string) {
  return `${cid}${KEY_SEP}${placement}`;
}

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

function cleanPlacement(placement: string, targetUrl: string | null, type?: string | null): string {
  const candidate = (placement || targetUrl || "").trim();
  if (!candidate) return "";
  const appMatch = candidate.match(/mobileapp::\d+-(.+)$/i);
  if (appMatch) return appMatch[1].toLowerCase();
  const numericAppMatch = candidate.match(/^\d+-(.+)$/i);
  if (numericAppMatch) return numericAppMatch[1].toLowerCase();
  return normalize(candidate, type);
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

function compactPlacement(host: string) { return normalize(host).replace(/[^a-z0-9]/g, ""); }

type AdsAggLite = { campaign_id: string; placement: string; cost: number; clicks: number };
function buildPlacementIndexes(ads: AdsAggLite[]) {
  const byExact = new Map<string, AdsAggLite[]>();
  const byRoot = new Map<string, AdsAggLite[]>();
  const byPrefix = new Map<string, AdsAggLite[]>();
  for (const a of ads) {
    const exact = normalize(a.placement);
    if (!exact) continue;
    const exactList = byExact.get(exact) ?? [];
    exactList.push(a); byExact.set(exact, exactList);
    const root = rootDomain(exact);
    if (root) { const rootList = byRoot.get(root) ?? []; rootList.push(a); byRoot.set(root, rootList); }
    const compact = compactPlacement(exact);
    for (let len = 8; len <= Math.min(16, compact.length); len++) {
      const prefix = compact.slice(0, len);
      const list = byPrefix.get(prefix) ?? [];
      list.push(a); byPrefix.set(prefix, list);
    }
  }
  return { byExact, byRoot, byPrefix };
}
function findPlacementMatches(placement: string, indexes: ReturnType<typeof buildPlacementIndexes>): AdsAggLite[] {
  const exact = normalize(placement);
  if (!exact) return [];
  const direct = indexes.byExact.get(exact);
  if (direct?.length) return direct;
  const root = rootDomain(exact);
  const rootMatches = root ? indexes.byRoot.get(root) : null;
  if (rootMatches?.length) return rootMatches;
  const compact = compactPlacement(exact);
  if (compact.length < 8) return [];
  for (let len = Math.min(16, compact.length); len >= 8; len--) {
    const matches = indexes.byPrefix.get(compact.slice(0, len));
    if (matches?.length) return matches;
  }
  return [];
}

// Extrai app id no formato Google Ads: "1-com.pacote" (Android) ou "2-123456789" (iOS).
function extractAppId(placementRaw: string, type?: string | null): string | null {
  if (type !== "MOBILE_APPLICATION") return null;
  const raw = (placementRaw || "").trim();
  if (!raw) return null;
  const m1 = raw.match(/mobileapp::([12]-[A-Za-z0-9._-]+)/i);
  if (m1) return m1[1];
  const m2 = raw.match(/^([12]-[A-Za-z0-9._-]+)$/);
  if (m2) return m2[1];
  // fallback: se vier só pacote tipo "com.whatsapp" assume Android
  if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(raw)) return `1-${raw}`;
  // iOS numeric
  if (/^\d{6,}$/.test(raw)) return `2-${raw}`;
  return null;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function applyNegativePlacements(admin: any, userId: string, items: ApplyItem[]) {
  const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;
  const accountIds = [...new Set(items.flatMap((i) => i.campaigns.map((c) => c.google_account_id)).filter(Boolean))];
  const { data: accs } = await admin
    .from("google_accounts")
    .select("id, customer_id, refresh_token, login_customer_id")
    .in("id", accountIds);
  const accMap = new Map<string, any>();
  const tokenCache = new Map<string, string>();
  for (const a of accs ?? []) accMap.set(a.id, a);

  const ops = new Map<string, { acc: any; campaign_id: string; placements: { placement: string; type: string; app_id: string | null }[] }>();
  for (const it of items) {
    // permite WEBSITE e MOBILE_APPLICATION (app só com app_id válido)
    if (it.type !== "WEBSITE" && it.type !== "MOBILE_APPLICATION") continue;
    if (it.type === "MOBILE_APPLICATION" && !it.app_id) continue;
    for (const c of it.campaigns) {
      const acc = accMap.get(c.google_account_id);
      if (!acc?.refresh_token) continue;
      const k = `${c.google_account_id}|${c.campaign_id}`;
      let g = ops.get(k);
      if (!g) { g = { acc, campaign_id: c.campaign_id, placements: [] }; ops.set(k, g); }
      if (!g.placements.some((p) => p.placement === it.placement)) {
        g.placements.push({ placement: it.placement, type: it.type, app_id: it.app_id ?? null });
      }
    }
  }

  const details: any[] = [];
  let applied = 0, failed = 0;

  for (const g of ops.values()) {
    try {
      const token = await getGoogleToken(g.acc.refresh_token, tokenCache);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "developer-token": devToken,
        "Content-Type": "application/json",
      };
      if (g.acc.login_customer_id) headers["login-customer-id"] = g.acc.login_customer_id;
      const operations = g.placements.map((p) => {
        const base = {
          campaign: `customers/${g.acc.customer_id}/campaigns/${g.campaign_id}`,
          negative: true,
        };
        if (p.type === "MOBILE_APPLICATION" && p.app_id) {
          return { create: { ...base, mobileApplication: { appId: p.app_id } } };
        }
        return {
          create: {
            ...base,
            placement: { url: p.placement.startsWith("http") ? p.placement : `https://${p.placement}` },
          },
        };
      });
      const r = await fetch(
        `https://googleads.googleapis.com/v21/customers/${g.acc.customer_id}/campaignCriteria:mutate`,
        { method: "POST", headers, body: JSON.stringify({ operations, partialFailure: true }) },
      );
      const j = await r.json();
      if (!r.ok) {
        failed += g.placements.length;
        details.push({ campaign_id: g.campaign_id, error: j?.error?.message ?? JSON.stringify(j) });
        await admin.from("automation_actions").insert({
          user_id: userId,
          campaign_id: g.campaign_id,
          action_type: "negative_placement",
          payload: { placements: g.placements },
          status: "failed",
          error: JSON.stringify(j),
          executed_at: new Date().toISOString(),
        });
        continue;
      }

      // Detecta partialFailureError: cada operação que falhou vem com um índice.
      const partial = j?.partialFailureError;
      const failedIdx = new Set<number>();
      if (partial?.details?.length) {
        for (const d of partial.details) {
          for (const err of d?.errors ?? []) {
            const path = err?.location?.fieldPathElements ?? [];
            for (const p of path) if (typeof p?.index === "number") failedIdx.add(p.index);
          }
        }
        // se tem erro mas não conseguimos mapear índice, marca tudo como falha
        if (failedIdx.size === 0) for (let i = 0; i < g.placements.length; i++) failedIdx.add(i);
      }
      // results pode vir vazio em createResource quando partial failure ocorre
      const results = j?.results ?? [];
      const okPlacements: typeof g.placements = [];
      const failPlacements: { p: typeof g.placements[number]; reason: string }[] = [];
      g.placements.forEach((p, idx) => {
        if (failedIdx.has(idx) || (results.length === g.placements.length && !results[idx]?.resourceName)) {
          const reason = partial?.message ?? "partial_failure";
          failPlacements.push({ p, reason });
        } else {
          okPlacements.push(p);
        }
      });

      applied += okPlacements.length;
      failed += failPlacements.length;
      details.push({
        campaign_id: g.campaign_id,
        count: okPlacements.length,
        failed_count: failPlacements.length,
        partial_message: partial?.message ?? null,
        partial_errors: partial?.details ?? null,
      });
      if (failPlacements.length) console.error("[placements-cleanup] partial failures", JSON.stringify({ campaign: g.campaign_id, failures: failPlacements, partial }));

      const inserts = okPlacements.map((p) => ({
        user_id: userId,
        campaign_id: g.campaign_id,
        placement: p.placement,
        action: "blacklist",
        note: "global cleanup applied",
      }));
      if (inserts.length) await admin.from("placement_actions").insert(inserts);
      await admin.from("automation_actions").insert({
        user_id: userId,
        campaign_id: g.campaign_id,
        action_type: "negative_placement",
        payload: { placements: g.placements, ok: okPlacements.map((p) => p.placement), failed: failPlacements.map((f) => ({ placement: f.p.placement, reason: f.reason })), partial: partial ?? null },
        status: failPlacements.length === g.placements.length ? "failed" : (failPlacements.length ? "partial" : "executed"),
        error: partial ? JSON.stringify(partial).slice(0, 2000) : null,
        executed_at: new Date().toISOString(),
      });
    } catch (e) {
      failed += g.placements.length;
      details.push({ campaign_id: g.campaign_id, error: String(e instanceof Error ? e.message : e) });
    }
  }
  return { applied, failed, details };
}
