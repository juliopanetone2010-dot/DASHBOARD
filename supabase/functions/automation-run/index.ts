// Cron diário (e trigger manual) da esteira inteligente de campanhas.
// - Lê daily_metrics (já populado por google-ads-sync-campaigns + gam-sync-revenue)
// - Calcula ROI dos últimos N dias com NET_FACTOR (mesma lógica do dashboard)
// - Classifica em: testing | learning | standby | scaling | bad | paused
// - Decide ação (pause | scale | cpa_up | cpa_down | none) respeitando cooldowns
// - Executa SOMENTE para pares site_id + google_account_id habilitados em site_automation_config
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const NET_FACTOR = 0.935;
const DEFAULT_STOPLOSS_ROI = -20;

type Lifecycle = "testing" | "learning" | "standby" | "scaling" | "bad" | "paused";
type SiteAutomationConfig = {
  id: string;
  user_id: string;
  site_id: string;
  google_account_id: string;
  automation_enabled: boolean;
  automation_dry_run: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({} as any));
    const force = !!body?.force;
    const selectedSiteId = typeof body?.site_id === "string" && body.site_id !== "all" ? body.site_id : null;
    const selectedAccountIds = Array.isArray(body?.google_account_ids)
      ? body.google_account_ids.map((id: unknown) => String(id)).filter(Boolean)
      : [];
    let onlyUserId: string | undefined = body?.user_id;

    // Se chamado com Authorization de um usuário (botão "Rodar agora"), restringe àquele user.
    const authHeader = req.headers.get("Authorization");
    let userJwt: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
      const sub = claims?.claims?.sub;
      if (sub) { onlyUserId = sub; userJwt = authHeader.replace("Bearer ", ""); }
    }

    if (force && !selectedSiteId) {
      return json({ error: "Selecione um site antes de rodar a automação." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Regras numéricas continuam em rules_config; habilitação agora é por site/conta.
    let rulesQuery = admin.from("rules_config").select("*");
    if (onlyUserId) rulesQuery = rulesQuery.eq("user_id", onlyUserId);
    const { data: rules, error: rulesErr } = await rulesQuery;
    if (rulesErr) throw rulesErr;
    const rulesByUser = new Map<string, any>();
    for (const cfg of rules ?? []) rulesByUser.set(cfg.user_id, cfg);

    let siteCfgQuery = admin.from("site_automation_config").select("*");
    if (onlyUserId) siteCfgQuery = siteCfgQuery.eq("user_id", onlyUserId);
    if (selectedSiteId) siteCfgQuery = siteCfgQuery.eq("site_id", selectedSiteId);
    if (selectedAccountIds.length > 0) siteCfgQuery = siteCfgQuery.in("google_account_id", selectedAccountIds);
    if (!force) siteCfgQuery = siteCfgQuery.eq("automation_enabled", true);

    const { data: siteConfigs, error: siteCfgErr } = await siteCfgQuery;
    if (siteCfgErr) throw siteCfgErr;

    const summary: any[] = [];
    for (const siteCfg of (siteConfigs ?? []) as SiteAutomationConfig[]) {
      const rulesCfg = rulesByUser.get(siteCfg.user_id);
      if (!rulesCfg) {
        summary.push({ user_id: siteCfg.user_id, site_id: siteCfg.site_id, google_account_id: siteCfg.google_account_id, skipped: "rules_missing" });
        continue;
      }
      if (!force && !siteCfg.automation_enabled) {
        summary.push({ user_id: siteCfg.user_id, site_id: siteCfg.site_id, google_account_id: siteCfg.google_account_id, skipped: "site_automation_disabled" });
        continue;
      }
      const cfg = { ...rulesCfg, automation_dry_run: siteCfg.automation_dry_run };
      const result = await runForSiteAccount(admin, cfg, siteCfg, userJwt);
      summary.push({ user_id: siteCfg.user_id, site_id: siteCfg.site_id, google_account_id: siteCfg.google_account_id, ...result });
      await admin
        .from("site_automation_config")
        .update({ last_run_at: new Date().toISOString() })
        .eq("id", siteCfg.id);
    }

    return json({ ok: true, runs: summary });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

async function runForSiteAccount(admin: any, cfg: any, siteCfg: SiteAutomationConfig, userJwt: string | null) {
  const userId = siteCfg.user_id;
  const siteId = siteCfg.site_id;
  const accountId = siteCfg.google_account_id;
  const dryRun: boolean = cfg.automation_dry_run !== false;
  const days: number = Math.max(1, Number(cfg.auto_analysis_days) || 7);

  const today = new Date();
  const yest = new Date(today); yest.setUTCDate(today.getUTCDate() - 1);
  const from = new Date(today); from.setUTCDate(today.getUTCDate() - days);
  const fromIso = isoDate(from);
  const toIso = isoDate(yest);

  const { data: link } = await admin
    .from("account_site_links")
    .select("id")
    .eq("user_id", userId)
    .eq("site_id", siteId)
    .eq("google_account_id", accountId)
    .maybeSingle();
  if (!link) return { window: { from: fromIso, to: toIso }, dry_run: dryRun, skipped: "site_account_not_linked" };

  // Garante que budget_micros e target_cpa_micros estão atualizados antes de decidir.
  // Sem isso, delivery_ratio fica null e a automação não consegue tomar ações de CPA/scale.
  const budgetSync = await syncCampaignBudgets(admin, userId, accountId);

  const { data: metrics } = await admin
    .from("daily_metrics")
    .select("campaign_id, google_account_id, date, spend, profit, clicks, conversions, impressions")
    .eq("user_id", userId)
    .eq("google_account_id", accountId)
    .gte("date", fromIso)
    .lte("date", toIso)
    .limit(50000);

  const byCamp = new Map<string, {
    campaign_id: string; google_account_id: string;
    spend: number; grossRevBrl: number; days: Set<string>;
    daily: { date: string; spend: number; profit: number; roi: number }[];
  }>();
  for (const r of metrics ?? []) {
    const cid = String(r.campaign_id);
    let agg = byCamp.get(cid);
    if (!agg) { agg = { campaign_id: cid, google_account_id: accountId, spend: 0, grossRevBrl: 0, days: new Set(), daily: [] }; byCamp.set(cid, agg); }
    const spend = Number(r.spend) || 0;
    const profit = Number(r.profit) || 0;
    const grossRevBrl = spend + profit;
    agg.spend += spend;
    agg.grossRevBrl += grossRevBrl;
    agg.days.add(String(r.date));
    const netRev = grossRevBrl * NET_FACTOR;
    const roi = spend > 0 ? ((netRev - spend) / spend) * 100 : 0;
    agg.daily.push({ date: String(r.date), spend, profit, roi });
  }

  const { data: states } = await admin
    .from("campaign_automation")
    .select("*")
    .eq("user_id", userId)
    .eq("google_account_id", accountId)
    .eq("site_id", siteId);
  const stateByCamp = new Map<string, any>();
  for (const s of states ?? []) stateByCamp.set(String(s.campaign_id), s);

  const { data: campRows } = await admin
    .from("campaigns")
    .select("campaign_id, name, status, google_account_id, budget_micros")
    .eq("user_id", userId)
    .eq("google_account_id", accountId);
  const campMeta = new Map<string, any>();
  for (const c of campRows ?? []) campMeta.set(String(c.campaign_id), c);

  let decisions = 0; let executed = 0; let skippedInactive = 0; let skippedSiteMismatch = 0; let skippedAmbiguousSite = 0;
  for (const agg of byCamp.values()) {
    const meta = campMeta.get(agg.campaign_id);
    const status = String(meta?.status ?? "").toLowerCase();
    if (!meta || (status !== "enabled" && status !== "active")) {
      skippedInactive++;
      continue;
    }

    const resolvedSiteId = await resolveCampaignSiteId(admin, userId, agg.campaign_id, accountId);
    if (!resolvedSiteId) {
      skippedAmbiguousSite++;
      await logSkip(admin, userId, siteId, accountId, agg, meta, "site_unresolved", "Campanha sem site confirmado; automação bloqueada por segurança.");
      continue;
    }
    if (resolvedSiteId !== siteId) {
      skippedSiteMismatch++;
      await logSkip(admin, userId, siteId, accountId, agg, meta, "site_mismatch", `Campanha pertence ao site ${resolvedSiteId}, não ao site selecionado ${siteId}.`);
      continue;
    }

    const dailyBudget = meta?.budget_micros ? Number(meta.budget_micros) / 1_000_000 : 0;
    const decision = classify(agg, cfg, stateByCamp.get(agg.campaign_id), dailyBudget);
    decisions++;
    const prevState = stateByCamp.get(agg.campaign_id);
    const fromStatus: Lifecycle | null = prevState?.lifecycle_status ?? null;

    const nowIso = new Date().toISOString();
    const newState: any = {
      user_id: userId,
      site_id: siteId,
      campaign_id: agg.campaign_id,
      google_account_id: accountId,
      lifecycle_status: decision.lifecycle,
      last_roi: round2(decision.roi),
      roi_trend: decision.trend,
      delivery_ratio: decision.delivery == null ? null : round2(decision.delivery),
      daily_budget: round2(dailyBudget),
      last_evaluated_at: nowIso,
    };
    if (decision.lifecycle === "standby" && fromStatus !== "standby") {
      newState.entered_standby_at = nowIso;
      newState.days_in_standby = 0;
    } else if (decision.lifecycle === "standby") {
      newState.days_in_standby = (prevState?.days_in_standby ?? 0) + 1;
    } else {
      newState.entered_standby_at = null;
      newState.days_in_standby = 0;
    }
    let execStatus: "executed" | "dry_run" | "skipped" | "failed" = "dry_run";
    let execError: string | null = null;
    if (decision.action !== "none") {
      if (dryRun) execStatus = "dry_run";
      else {
        try {
          await applyMutation(userJwt, userId, agg.campaign_id, accountId, siteId, decision, cfg);
          execStatus = "executed"; executed++;
        } catch (e) { execStatus = "failed"; execError = String(e instanceof Error ? e.message : e); }
      }
    } else {
      execStatus = "skipped";
    }

    if (execStatus === "executed") {
      if (decision.action === "scale") {
        newState.last_scale_date = nowIso;
        newState.cooldown_until = new Date(Date.now() + (Number(cfg.auto_scale_interval_days) || 2) * 86400_000).toISOString();
      }
      if (decision.action === "cpa_up" || decision.action === "cpa_down") {
        newState.last_cpa_action = decision.action;
        newState.last_cpa_action_date = nowIso;
      }
      newState.last_action = decision.action;
      newState.last_action_date = nowIso;
      if (decision.delivery_driven) {
        newState.last_delivery_action = decision.action;
        newState.last_delivery_action_date = nowIso;
      }
    }

    await admin.from("campaign_automation").upsert(newState, { onConflict: "user_id,site_id,google_account_id,campaign_id" });

    await admin.from("automation_logs").insert({
      user_id: userId,
      site_id: siteId,
      google_account_id: accountId,
      campaign_id: agg.campaign_id,
      action: decision.action === "none" ? "classify" : decision.action,
      reason: decision.reason,
      decision: execStatus,
      roi: round2(decision.roi),
      cost: round2(agg.spend),
      revenue: round2(agg.grossRevBrl * NET_FACTOR),
      lifecycle_from: fromStatus,
      lifecycle_to: decision.lifecycle,
      payload: {
        trend: decision.trend,
        days: agg.days.size,
        name: meta?.name ?? null,
        site_id: siteId,
        google_account_id: accountId,
        delivery_ratio: decision.delivery == null ? null : round2(decision.delivery),
        daily_budget: round2(dailyBudget),
        avg_daily_spend: round2(decision.avgDailySpend ?? 0),
        delivery_driven: !!decision.delivery_driven,
        daily: agg.daily.slice(-days),
      },
      error: execError,
    });
  }

  return { window: { from: fromIso, to: toIso }, dry_run: dryRun, campaigns: byCamp.size, decisions, executed, skipped_inactive: skippedInactive, skipped_site_mismatch: skippedSiteMismatch, skipped_ambiguous_site: skippedAmbiguousSite, budget_sync: budgetSync };
}

// Sincroniza budget_micros e target_cpa_micros das campanhas direto do Google Ads,
// para que a automação tenha delivery_ratio confiável antes de decidir ações.
async function syncCampaignBudgets(admin: any, userId: string, accountId: string): Promise<{ updated: number; error?: string }> {
  try {
    const { data: acc } = await admin
      .from("google_accounts")
      .select("customer_id, login_customer_id, refresh_token")
      .eq("id", accountId)
      .maybeSingle();
    if (!acc?.refresh_token || !acc?.customer_id) return { updated: 0, error: "no_refresh_token" };

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;

    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: acc.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokJson = await tokRes.json();
    if (!tokRes.ok) return { updated: 0, error: `token: ${JSON.stringify(tokJson).slice(0, 200)}` };
    const accessToken = tokJson.access_token as string;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": devToken,
      "Content-Type": "application/json",
    };
    if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;

    const query = `
      SELECT campaign.id, campaign.name, campaign.status,
             campaign_budget.amount_micros,
             campaign.target_cpa.target_cpa_micros,
             campaign.maximize_conversions.target_cpa_micros
      FROM campaign
      WHERE campaign.status = 'ENABLED'
    `;
    const res = await fetch(
      `https://googleads.googleapis.com/v21/customers/${acc.customer_id}/googleAds:search`,
      { method: "POST", headers, body: JSON.stringify({ query }) },
    );
    const json = await res.json();
    if (!res.ok) return { updated: 0, error: `search: ${JSON.stringify(json).slice(0, 200)}` };

    const rows = (json.results ?? []) as any[];
    const updates = rows.map((r) => ({
      user_id: userId,
      google_account_id: accountId,
      campaign_id: String(r.campaign.id),
      name: r.campaign.name ?? `Campaign ${r.campaign.id}`,
      status: String(r.campaign.status ?? "enabled").toLowerCase(),
      budget_micros: r.campaignBudget?.amountMicros ? Number(r.campaignBudget.amountMicros) : null,
      target_cpa_micros: r.campaign.targetCpa?.targetCpaMicros
        ? Number(r.campaign.targetCpa.targetCpaMicros)
        : (r.campaign.maximizeConversions?.targetCpaMicros ? Number(r.campaign.maximizeConversions.targetCpaMicros) : null),
    }));
    let updated = 0;
    for (let i = 0; i < updates.length; i += 200) {
      const slice = updates.slice(i, i + 200);
      const { error } = await admin
        .from("campaigns")
        .upsert(slice, { onConflict: "user_id,google_account_id,campaign_id" });
      if (!error) updated += slice.length;
    }
    return { updated };
  } catch (e) {
    return { updated: 0, error: String(e instanceof Error ? e.message : e) };
  }
}

async function resolveCampaignSiteId(admin: any, userId: string, campaignId: string, accountId: string): Promise<string | null> {
  // Resolução SEGURA: somente via revenue real do GAM com campaign_id confirmado.
  // gam_campaign_source_revenue também guarda linhas agregadas (__aggregate__) por origem;
  // para automação usamos gam_placement_revenue porque ela vem de UTM de campanha/placement.
  const { data: revenueSites } = await admin
    .from("gam_placement_revenue")
    .select("site_id, revenue_usd")
    .eq("user_id", userId)
    .eq("campaign_id", campaignId)
    .not("site_id", "is", null)
    .limit(1000);

  const bySite = new Map<string, number>();
  for (const row of revenueSites ?? []) {
    const sid = String(row.site_id ?? "");
    if (!sid) continue;
    bySite.set(sid, (bySite.get(sid) ?? 0) + (Number(row.revenue_usd) || 0));
  }
  if (bySite.size === 1) return [...bySite.keys()][0];
  if (bySite.size > 1) return [...bySite.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // Sem revenue GAM = não conseguimos confirmar o site. Não tocar.
  return null;
}

async function logSkip(admin: any, userId: string, siteId: string, accountId: string, agg: any, meta: any, code: string, reason: string) {
  await admin.from("automation_logs").insert({
    user_id: userId,
    site_id: siteId,
    google_account_id: accountId,
    campaign_id: agg.campaign_id,
    action: "classify",
    reason,
    decision: "skipped",
    roi: null,
    cost: round2(agg.spend),
    revenue: round2(agg.grossRevBrl * NET_FACTOR),
    payload: { code, name: meta?.name ?? null, selected_site_id: siteId, google_account_id: accountId },
  });
}

function classify(agg: any, cfg: any, prev: any, dailyBudget: number): {
  lifecycle: Lifecycle; action: "none" | "pause" | "scale" | "cpa_up" | "cpa_down";
  reason: string; roi: number; trend: "up" | "down" | "flat";
  delivery: number | null; avgDailySpend: number; delivery_driven?: boolean;
} {
  const days = agg.days.size;
  const cost = agg.spend;
  const netRev = agg.grossRevBrl * NET_FACTOR;
  const roi = cost > 0 ? ((netRev - cost) / cost) * 100 : 0;
  const stopLossRoi = normalizeStopLossRoi(cfg.auto_stoploss_min_roi);
  const stopLossDays = Math.max(1, Number(cfg.auto_stoploss_days) || 7);
  const stopLossMinCost = Math.max(0, Number(cfg.auto_stoploss_min_cost) || 0);

  const sorted = [...agg.daily].sort((a, b) => a.date.localeCompare(b.date));
  const mid = Math.floor(sorted.length / 2);
  const avg = (arr: any[]) => arr.length ? arr.reduce((s, x) => s + x.roi, 0) / arr.length : 0;
  const r1 = avg(sorted.slice(0, mid));
  const r2 = avg(sorted.slice(mid));
  const diff = r2 - r1;
  const trend: "up" | "down" | "flat" = Math.abs(diff) < 5 ? "flat" : diff > 0 ? "up" : "down";

  // DELIVERY: gasto médio diário vs orçamento diário configurado.
  const avgDailySpend = days > 0 ? cost / days : 0;
  const delivery = dailyBudget > 0 ? avgDailySpend / dailyBudget : null;
  const deliveryPct = delivery == null ? "?" : `${Math.round(delivery * 100)}%`;
  const HIGH_DELIVERY = 0.8;
  const isSaturated = delivery != null && delivery >= HIGH_DELIVERY;
  const isUnderDelivering = delivery != null && delivery < HIGH_DELIVERY;
  const noBudgetData = delivery == null;

  if (days < Math.min(2, Number(cfg.auto_analysis_days) || 7) || cost < stopLossMinCost) {
    return { lifecycle: "testing", action: "none", reason: `Dados insuficientes (dias=${days}, custo=${round2(cost)})`, roi, trend, delivery, avgDailySpend };
  }

  const inCooldown = prev?.cooldown_until && new Date(prev.cooldown_until) > new Date();
  const cpaUpPct = Number(cfg.auto_cpa_up_pct) || 10;
  const cpaDownPct = Number(cfg.auto_cpa_down_pct) || 10;
  const lastCpa = prev?.last_cpa_action_date ? new Date(prev.last_cpa_action_date) : null;
  const daysSinceCpa = lastCpa ? Math.floor((Date.now() - lastCpa.getTime()) / 86400_000) : 999;
  const cpaCooldownOk = daysSinceCpa >= Number(cfg.auto_cpa_review_days);

  // E) Stop-loss prevalece SOMENTE quando o ROI agregado cruza o limite negativo configurado.
  // Se a configuração vier vazia/0 por legado, usamos -20% para impedir pausa cega em ROI levemente negativo.
  if (roi <= stopLossRoi && days >= stopLossDays && trend !== "up") {
    return { lifecycle: "bad", action: "pause", reason: `ROI ${round2(roi)}% <= ${stopLossRoi}% por ${days}d (tendência ${trend}, delivery ${deliveryPct}) → pausar`, roi, trend, delivery, avgDailySpend };
  }

  // A) ROI ≥ scale_min (default 30%) → escala via budget se saturado, senão CPA up.
  if (roi >= Number(cfg.auto_scale_min_roi)) {
    if (inCooldown) return { lifecycle: "scaling", action: "none", reason: `ROI ${round2(roi)}% (delivery ${deliveryPct}) em cooldown até ${prev.cooldown_until}`, roi, trend, delivery, avgDailySpend };
    if (noBudgetData) {
      return { lifecycle: "scaling", action: "none", reason: `ROI ${round2(roi)}% mas orçamento diário não sincronizado — sem ação até ter delivery confiável`, roi, trend, delivery, avgDailySpend };
    }
    if (isSaturated) {
      return { lifecycle: "scaling", action: "scale", reason: `ROI ${round2(roi)}% e delivery ${deliveryPct} → +${cfg.auto_scale_budget_pct}% no orçamento`, roi, trend, delivery, avgDailySpend, delivery_driven: true };
    }
    if (!cpaCooldownOk) return { lifecycle: "scaling", action: "none", reason: `ROI ${round2(roi)}% mas delivery ${deliveryPct} <80% — aguardando review CPA (${daysSinceCpa}/${cfg.auto_cpa_review_days}d)`, roi, trend, delivery, avgDailySpend };
    return { lifecycle: "scaling", action: "cpa_up", reason: `ROI ${round2(roi)}% mas delivery ${deliveryPct} <80% → +${cpaUpPct}% no CPA para destravar volume`, roi, trend, delivery, avgDailySpend, delivery_driven: true };
  }

  // B) ROI 10–30 → learning. Saturado: leve scale. Subentrega: NÃO mexer no CPA (ROI ainda baixo demais).
  if (roi >= 10 && roi < Number(cfg.auto_scale_min_roi)) {
    if (noBudgetData) {
      return { lifecycle: "learning", action: "none", reason: `ROI ${round2(roi)}% — orçamento diário não sincronizado, observando`, roi, trend, delivery, avgDailySpend };
    }
    if (isSaturated) {
      if (inCooldown) return { lifecycle: "learning", action: "none", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} em cooldown`, roi, trend, delivery, avgDailySpend };
      const lightPct = Math.max(5, Math.round((Number(cfg.auto_scale_budget_pct) || 20) / 2));
      return { lifecycle: "learning", action: "scale", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} → leve scale +${lightPct}%`, roi, trend, delivery, avgDailySpend, delivery_driven: true, _lightScalePct: lightPct } as any;
    }
    return { lifecycle: "learning", action: "none", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} <80% — observando (ROI insuficiente para subir CPA)`, roi, trend, delivery, avgDailySpend };
  }

  // C) ROI 1–10 (standby): saturado → CPA down (proteger margem). Subentrega → observar (não subir CPA com ROI baixo).
  if (roi > 0 && roi < 10) {
    const enteredAt = prev?.entered_standby_at ? new Date(prev.entered_standby_at) : null;
    const daysIn = enteredAt ? Math.floor((Date.now() - enteredAt.getTime()) / 86400_000) : 0;
    if (noBudgetData) {
      return { lifecycle: "standby", action: "none", reason: `ROI ${round2(roi)}% (standby ${daysIn}d) — orçamento diário não sincronizado, observando`, roi, trend, delivery, avgDailySpend };
    }
    if (isSaturated) {
      if (!cpaCooldownOk) return { lifecycle: "standby", action: "none", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} (standby ${daysIn}d) — aguardando review CPA (${daysSinceCpa}/${cfg.auto_cpa_review_days}d)`, roi, trend, delivery, avgDailySpend };
      return { lifecycle: "standby", action: "cpa_down", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} → -${cpaDownPct}% CPA (melhorar qualidade)`, roi, trend, delivery, avgDailySpend, delivery_driven: true };
    }
    return { lifecycle: "standby", action: "none", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} (standby ${daysIn}d) — observando (ROI baixo, não subir CPA)`, roi, trend, delivery, avgDailySpend };
  }

  // D) ROI -10 a 0: saturado → CPA down (cortar prejuízo). Subentrega → observar (NÃO subir CPA em ROI negativo).
  if (roi >= -10 && roi <= 0) {
    if (noBudgetData) {
      return { lifecycle: "learning", action: "none", reason: `ROI ${round2(roi)}% — orçamento diário não sincronizado, observando`, roi, trend, delivery, avgDailySpend };
    }
    if (isSaturated) {
      if (!cpaCooldownOk) return { lifecycle: "learning", action: "none", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} — aguardando review CPA (${daysSinceCpa}/${cfg.auto_cpa_review_days}d)`, roi, trend, delivery, avgDailySpend };
      return { lifecycle: "learning", action: "cpa_down", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} → -${cpaDownPct}% CPA (cortar prejuízo)`, roi, trend, delivery, avgDailySpend, delivery_driven: true };
    }
    return { lifecycle: "learning", action: "none", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} — observando (ROI negativo, sem subir CPA)`, roi, trend, delivery, avgDailySpend };
  }

  return { lifecycle: "learning", action: "none", reason: `ROI ${round2(roi)}% delivery ${deliveryPct} — observando`, roi, trend, delivery, avgDailySpend };
}

async function applyMutation(userJwt: string, campaignId: string, accountId: string, siteId: string, decision: any, cfg: any) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`;
  const body: any = { campaign_id: campaignId, google_account_id: accountId, site_id: siteId };
  if (decision.action === "pause") { body.action = "set_status"; body.status = "PAUSED"; }
  else if (decision.action === "scale") { body.action = "adjust_budget"; body.delta_pct = Number(decision._lightScalePct) || Number(cfg.auto_scale_budget_pct) || 20; }
  else if (decision.action === "cpa_up") { body.action = "adjust_cpa"; body.delta_pct = Number(decision._lightCpaPct) || Number(cfg.auto_cpa_up_pct) || 10; }
  else if (decision.action === "cpa_down") { body.action = "adjust_cpa"; body.delta_pct = -(Number(cfg.auto_cpa_down_pct) || 10); }
  else return;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userJwt}` },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.error) throw new Error(j?.error || `mutate failed: ${res.status}`);
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function round2(n: number) { return Math.round((Number(n) || 0) * 100) / 100; }
function normalizeStopLossRoi(value: unknown) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw >= 0) return DEFAULT_STOPLOSS_ROI;
  return raw;
}
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
