// Funil Inteligente — esteira de aprendizado e escala para campanhas novas.
// Lifecycle isolado em campaign_funnel.
//
// Estados:
//   learning           -> 5 dias em Maximize Conversions (sem mexer)
//   cpa-learning       -> 2-3 dias após migrar para Target CPA
//   scaling            -> escalar +20% a cada 2 dias se ROI>15% e delivery>70%
//   advanced-scaling   -> ROI>25% por 5d: +20% budget e -5% CPA
//   stable             -> 7d ROI positivo + delivery>70% -> graduar
//   graduated          -> entrega para automation-run
//   failed-learning    -> pausada após learning com ROI < -15%
//   paused             -> proteção (ROI<-30% por 3d, delivery<20%, etc)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const NET_FACTOR = 0.935;

// Janelas (dias)
const LEARNING_DAYS = 5;
const CPA_LEARNING_DAYS = 3;
const SCALE_COOLDOWN_DAYS = 2;
const ADV_SCALE_DAYS = 5;
const CPA_COOLDOWN_DAYS = 3;
const STABLE_DAYS = 7;
const PROTECT_BAD_ROI_DAYS = 3;

// Limiares
const FAIL_LEARNING_ROI = -15;
const SCALE_MIN_ROI = 15;
const ADV_SCALE_MIN_ROI = 25;
const SCALE_MIN_DELIVERY = 0.7;
const ADV_SCALE_MIN_DELIVERY = 0.9;
const PROTECT_LOW_DELIVERY = 0.2;
const PROTECT_BAD_ROI = -30;
const SCALE_PCT = 20;
const ADV_CPA_REDUCE_PCT = -5;
const CPA_UP_LOW_ROI_PCT = 10;
const CPA_UP_LOW_DELIVERY_PCT = 15;
const NEW_CAMPAIGN_LOOKBACK_DAYS = 2;

type SiteFunnelConfig = {
  user_id: string;
  site_id: string;
  google_account_id: string;
  funnel_enabled: boolean;
  funnel_dry_run: boolean;
  initial_budget: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({} as any));
    const force = !!body?.force;
    const enrollAll = !!body?.enroll_all_created || !!body?.enroll_all;
    const onboardOnly = !!body?.onboard_only;
    const selectedSiteId = typeof body?.site_id === "string" && body.site_id !== "all" ? body.site_id : null;
    const selectedAccountIds: string[] = Array.isArray(body?.google_account_ids)
      ? body.google_account_ids.map((id: unknown) => String(id)).filter(Boolean)
      : [];
    let onlyUserId: string | undefined = body?.user_id;
    let userJwt: string | null = null;

    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
      const sub = claims?.claims?.sub;
      if (sub) { onlyUserId = sub; userJwt = authHeader.replace("Bearer ", ""); }
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let cfgQuery = admin.from("site_funnel_config").select("*");
    if (onlyUserId) cfgQuery = cfgQuery.eq("user_id", onlyUserId);
    if (selectedSiteId) cfgQuery = cfgQuery.eq("site_id", selectedSiteId);
    if (selectedAccountIds.length > 0) cfgQuery = cfgQuery.in("google_account_id", selectedAccountIds);
    if (!force) cfgQuery = cfgQuery.eq("funnel_enabled", true);

    let { data: configs, error: cfgErr } = await cfgQuery;
    if (cfgErr) throw cfgErr;

    if (enrollAll && force && (!configs || configs.length === 0) && onlyUserId) {
      configs = await buildMissingConfigs(admin, onlyUserId, selectedSiteId, selectedAccountIds);
      if (configs.length > 0) {
        const { error: upsertCfgErr } = await admin
          .from("site_funnel_config")
          .upsert(configs, { onConflict: "user_id,site_id,google_account_id" });
        if (upsertCfgErr) throw upsertCfgErr;
      }
    }

    const summary: any[] = [];
    for (const cfg of (configs ?? []) as SiteFunnelConfig[]) {
      try {
        const result = await runForSite(admin, cfg, userJwt, enrollAll, onboardOnly);
        summary.push({ site_id: cfg.site_id, google_account_id: cfg.google_account_id, ...result });
      } catch (e) {
        summary.push({ site_id: cfg.site_id, google_account_id: cfg.google_account_id, error: String(e) });
      }
    }

    return json({ ok: true, processed: summary.length, summary });
  } catch (e) {
    console.error("[funnel-smart-run] uncaught", e);
    return json({ error: String(e) }, 500);
  }
});

async function runForSite(admin: any, cfg: SiteFunnelConfig, userJwt: string | null, enrollAll = false, onboardOnly = false) {
  const { user_id, site_id, google_account_id, funnel_dry_run, initial_budget } = cfg;
  const dryRun = funnel_dry_run;

  // 1) Detectar campanhas novas para entrar no funil
  const onboarded = await onboardNewCampaigns(admin, cfg, enrollAll);
  if (onboardOnly) {
    return { onboarded, evaluated: 0, actions: 0, errors: 0, dry_run: dryRun };
  }

  // 2) Avaliar todas as campanhas atualmente no funil para esse user/site/conta
  const { data: funnelRows } = await admin
    .from("campaign_funnel")
    .select("*")
    .eq("user_id", user_id)
    .eq("site_id", site_id)
    .eq("google_account_id", google_account_id)
    .not("funnel_status", "in", "(graduated,failed-learning)");

  let evaluated = 0, actions = 0, errors = 0;

  for (const row of funnelRows ?? []) {
    try {
      const acted = await evaluateFunnelRow(admin, row, dryRun, userJwt, initial_budget);
      evaluated++;
      if (acted) actions++;
    } catch (e) {
      errors++;
      await logFunnelAction(admin, row, {
        action: "error", reason: String(e), dry_run: dryRun, error: String(e),
      });
    }
  }

  await admin.from("site_funnel_config")
    .update({ last_run_at: new Date().toISOString() })
    .eq("user_id", user_id)
    .eq("site_id", site_id)
    .eq("google_account_id", google_account_id);

  return { onboarded, evaluated, actions, errors, dry_run: dryRun };
}

async function buildMissingConfigs(admin: any, userId: string, selectedSiteId: string | null, selectedAccountIds: string[]): Promise<SiteFunnelConfig[]> {
  let accountIds = selectedAccountIds;
  if (accountIds.length === 0 && selectedSiteId) {
    const { data: links } = await admin
      .from("account_site_links")
      .select("google_account_id")
      .eq("user_id", userId)
      .eq("site_id", selectedSiteId);
    accountIds = [...new Set((links ?? []).map((l: any) => String(l.google_account_id)).filter(Boolean))];
  }

  if (!selectedSiteId) {
    let linkQ = admin.from("account_site_links").select("site_id, google_account_id").eq("user_id", userId);
    if (accountIds.length > 0) linkQ = linkQ.in("google_account_id", accountIds);
    const { data: links } = await linkQ;
    const seen = new Set<string>();
    return (links ?? []).filter((l: any) => {
      const key = `${l.site_id}:${l.google_account_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((l: any) => ({
      user_id: userId,
      site_id: String(l.site_id),
      google_account_id: String(l.google_account_id),
      funnel_enabled: true,
      funnel_dry_run: true,
      initial_budget: 30,
    }));
  }

  return accountIds.map((google_account_id) => ({
    user_id: userId,
    site_id: selectedSiteId,
    google_account_id,
    funnel_enabled: true,
    funnel_dry_run: true,
    initial_budget: 30,
  }));
}

// === Onboarding: detecta campanhas novas, winners de geo-expansion, restarts manuais ===
async function onboardNewCampaigns(admin: any, cfg: SiteFunnelConfig, enrollAll = false) {
  const { user_id, site_id, google_account_id, initial_budget } = cfg;

  // Já no funil
  const { data: existing } = await admin
    .from("campaign_funnel")
    .select("campaign_id")
    .eq("user_id", user_id);
  const inFunnel = new Set((existing ?? []).map((r: any) => r.campaign_id));

  const candidates = new Map<string, { name: string; source: string }>();

  // Auto: campanhas criadas nos últimos N dias na conta+site
  // (ou TODAS as criadas, se enrollAll=true)
  let campQuery = admin
    .from("campaigns")
    .select("campaign_id, name, created_at, google_account_id, status, target_cpa_micros")
    .eq("user_id", user_id)
    .eq("google_account_id", google_account_id)
    .eq("status", "enabled")
    .is("target_cpa_micros", null); // só Maximizar Conversões (sem Target CPA)
  const since = new Date(Date.now() - NEW_CAMPAIGN_LOOKBACK_DAYS * 86400_000).toISOString();
  if (!enrollAll) campQuery = campQuery.gte("created_at", since);
  const since3d = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data: newCamps } = await campQuery;

  // Filtro extra: precisa ter ao menos 1 ad ENABLED nos últimos 14 dias (ativo ou em análise)
  const campIds = (newCamps ?? []).map((c: any) => c.campaign_id);
  const adsSince = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const withActiveAds = new Set<string>();
  if (campIds.length > 0) {
    const { data: ads } = await admin
      .from("creative_metrics")
      .select("campaign_id")
      .eq("user_id", user_id)
      .eq("ad_status", "ENABLED")
      .gte("date", adsSince)
      .in("campaign_id", campIds);
    for (const a of ads ?? []) withActiveAds.add(a.campaign_id);
  }

  for (const c of newCamps ?? []) {
    if (inFunnel.has(c.campaign_id)) continue;
    if (!withActiveAds.has(c.campaign_id)) continue; // pula campanhas sem ads ativos
    // Regra: só "winner" no nome OU criada nos últimos 3 dias
    const isWinner = /winner/i.test(c.name ?? "");
    const isRecent = c.created_at && c.created_at >= since3d;
    if (!isWinner && !isRecent) continue;
    candidates.set(c.campaign_id, { name: c.name, source: enrollAll ? "manual_bulk" : (isWinner ? "winner" : "auto") });
  }

  // Winners de geo-expansion
  const { data: winners } = await admin
    .from("campaign_expansion_logs")
    .select("new_campaign_id, new_campaign_name, site_id, google_account_id, status")
    .eq("user_id", user_id)
    .eq("site_id", site_id)
    .eq("google_account_id", google_account_id)
    .eq("status", "executed")
    .not("new_campaign_id", "is", null)
    .gte("created_at", since);
  for (const w of winners ?? []) {
    if (w.new_campaign_id && !inFunnel.has(w.new_campaign_id)) {
      candidates.set(w.new_campaign_id, { name: w.new_campaign_name ?? w.new_campaign_id, source: "geo_winner" });
    }
  }

  // Restarts manuais
  const { data: restarts } = await admin
    .from("campaign_restart_flow")
    .select("campaign_id, site_id, google_account_id, status, start_date")
    .eq("user_id", user_id)
    .eq("site_id", site_id)
    .eq("google_account_id", google_account_id)
    .eq("status", "active")
    .gte("start_date", since);
  for (const r of restarts ?? []) {
    if (!inFunnel.has(r.campaign_id)) {
      // Resolve nome
      const camp = (newCamps ?? []).find((c: any) => c.campaign_id === r.campaign_id);
      candidates.set(r.campaign_id, { name: camp?.name ?? r.campaign_id, source: "restart" });
    }
  }

  if (candidates.size === 0) return 0;

  // Resolve nomes que ainda estão como ID
  const needName = [...candidates.entries()].filter(([id, v]) => !v.name || v.name === id).map(([id]) => id);
  if (needName.length > 0) {
    const { data: named } = await admin
      .from("campaigns")
      .select("campaign_id, name")
      .eq("user_id", user_id)
      .in("campaign_id", needName);
    for (const n of named ?? []) {
      const cur = candidates.get(n.campaign_id);
      if (cur && n.name) candidates.set(n.campaign_id, { ...cur, name: n.name });
    }
  }

  const inserts = [...candidates.entries()].map(([campaign_id, v]) => ({
    user_id, site_id, google_account_id,
    campaign_id, campaign_name: v.name,
    funnel_status: "learning",
    entry_source: v.source,
    initial_budget,
    current_budget: initial_budget,
    learning_started_at: new Date().toISOString(),
  }));

  await admin.from("campaign_funnel").upsert(inserts, { onConflict: "user_id,campaign_id" });

  for (const ins of inserts) {
    await logFunnelAction(admin, ins, {
      action: "enter_funnel",
      reason: `Entrou no Funil Inteligente via ${ins.entry_source}`,
      status_to: "learning",
      dry_run: true,
    });
  }
  return inserts.length;
}

// === Avaliação por linha ===
async function evaluateFunnelRow(admin: any, row: any, dryRun: boolean, userJwt: string | null, defaultBudget: number): Promise<boolean> {
  const userId = row.user_id;
  const campaignId = row.campaign_id;

  // Buscar daily_metrics dos últimos 30d
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const { data: metrics } = await admin
    .from("daily_metrics")
    .select("date, spend, revenue, profit, conversions, clicks, impressions")
    .eq("user_id", userId)
    .eq("campaign_id", campaignId)
    .gte("date", since)
    .order("date", { ascending: true });

  const days = (metrics ?? []).map((m: any) => ({
    date: m.date,
    spend: Number(m.spend) || 0,
    grossRev: ((Number(m.profit) || 0) + (Number(m.spend) || 0)),
    netRev: ((Number(m.profit) || 0) + (Number(m.spend) || 0)) * NET_FACTOR,
    conversions: Number(m.conversions) || 0,
    clicks: Number(m.clicks) || 0,
    impressions: Number(m.impressions) || 0,
  }));

  // Métricas atuais
  const totalSpend = days.reduce((s, d) => s + d.spend, 0);
  const totalNetRev = days.reduce((s, d) => s + d.netRev, 0);
  const totalConv = days.reduce((s, d) => s + d.conversions, 0);
  const roiPct = totalSpend > 0 ? ((totalNetRev - totalSpend) / totalSpend) * 100 : 0;
  const avgCpa = totalConv > 0 ? totalSpend / totalConv : 0;

  const budget = Number(row.current_budget) || defaultBudget;
  const expectedSpend = budget * Math.max(1, days.length);
  const deliveryRate = expectedSpend > 0 ? Math.min(2, totalSpend / expectedSpend) : 0;

  const status = String(row.funnel_status);
  const now = new Date();
  const learningStart = new Date(row.learning_started_at);
  const daysSinceLearn = Math.floor((now.getTime() - learningStart.getTime()) / 86400_000);

  const updates: any = {
    last_evaluated_at: now.toISOString(),
    last_roi_pct: roiPct,
    last_delivery_rate: deliveryRate,
  };

  // Helpers de ação
  const apply = async (action: string, params: any, reason: string, statusTo: string | null, extras: any = {}) => {
    let error: string | null = null;
    let executed = false;
    if (!dryRun) {
      try {
        const r = await callMutate(action, { campaign_id: campaignId, site_id: row.site_id, google_account_id: row.google_account_id, ...params }, userJwt, userId);
        if (r?.error) error = r.error; else executed = true;
      } catch (e) { error = String(e); }
    }
    await logFunnelAction(admin, row, {
      action, reason,
      status_from: status, status_to: statusTo ?? status,
      roi_pct: roiPct, delivery_rate: deliveryRate, avg_cpa: avgCpa,
      dry_run: dryRun, error,
      payload: { params, executed, ...extras },
    });
    if (statusTo) updates.funnel_status = statusTo;
    Object.assign(updates, extras);
    return executed || dryRun;
  };

  let acted = false;

  // === PROTEÇÃO (vale para qualquer estado ativo, exceto learning inicial < 3d) ===
  if (status !== "learning" || daysSinceLearn >= 3) {
    const last3 = days.slice(-3);
    const last3Spend = last3.reduce((s, d) => s + d.spend, 0);
    const last3Net = last3.reduce((s, d) => s + d.netRev, 0);
    const last3Roi = last3Spend > 0 ? ((last3Net - last3Spend) / last3Spend) * 100 : 0;

    const protectionTrigger =
      (last3.length >= 3 && last3Roi < PROTECT_BAD_ROI) ||
      deliveryRate < PROTECT_LOW_DELIVERY ||
      (totalSpend > budget * 3 && totalConv === 0);

    if (protectionTrigger) {
      acted = await apply("set_status", { status: "PAUSED" },
        `Proteção: ROI3d=${last3Roi.toFixed(1)}% | delivery=${(deliveryRate*100).toFixed(0)}% | conv=${totalConv}`,
        "paused", { paused_at: now.toISOString() });
      await persistFunnel(admin, row.id, updates);
      return acted;
    }
  }

  // === Estado: learning ===
  if (status === "learning") {
    if (daysSinceLearn < LEARNING_DAYS) {
      updates.next_action_hint = `Aguardando aprendizado (${daysSinceLearn}/${LEARNING_DAYS}d)`;
      await persistFunnel(admin, row.id, updates);
      return false;
    }
    // 6º dia
    if (roiPct < FAIL_LEARNING_ROI) {
      acted = await apply("set_status", { status: "PAUSED" },
        `Falhou no aprendizado: ROI ${roiPct.toFixed(1)}% < ${FAIL_LEARNING_ROI}%`,
        "failed-learning", { paused_at: now.toISOString() });
    } else {
      // Migrar para Target CPA com média dos 5 dias
      const last5 = days.slice(-LEARNING_DAYS);
      const conv5 = last5.reduce((s, d) => s + d.conversions, 0);
      const spend5 = last5.reduce((s, d) => s + d.spend, 0);
      const cpa5 = conv5 > 0 ? spend5 / conv5 : avgCpa;
      if (cpa5 <= 0) {
        updates.next_action_hint = "Sem conversões para calcular CPA — mantendo observação";
        await persistFunnel(admin, row.id, updates);
        return false;
      }
      acted = await apply("set_target_cpa", { target_cpa: Number(cpa5.toFixed(2)) },
        `Migrando para Target CPA = R$${cpa5.toFixed(2)} (média 5d)`,
        "cpa-learning", {
          cpa_learning_started_at: now.toISOString(),
          applied_target_cpa: cpa5,
          avg_cpa_5d: cpa5,
          last_cpa_change_at: now.toISOString(),
          cooldown_cpa_until: addDays(now, CPA_COOLDOWN_DAYS).toISOString(),
        });
    }
    await persistFunnel(admin, row.id, updates);
    return acted;
  }

  // === Estado: cpa-learning ===
  if (status === "cpa-learning") {
    const cpaStart = new Date(row.cpa_learning_started_at ?? row.learning_started_at);
    const daysIn = Math.floor((now.getTime() - cpaStart.getTime()) / 86400_000);
    if (daysIn < CPA_LEARNING_DAYS) {
      updates.next_action_hint = `Observando Target CPA (${daysIn}/${CPA_LEARNING_DAYS}d)`;
      await persistFunnel(admin, row.id, updates);
      return false;
    }
    // Decisão pós CPA-learning
    if (roiPct >= SCALE_MIN_ROI && deliveryRate >= SCALE_MIN_DELIVERY) {
      updates.scaling_started_at = now.toISOString();
      updates.funnel_status = "scaling";
      updates.next_action_hint = "Pronto para escalar";
      await logFunnelAction(admin, row, {
        action: "promote", reason: `Promovido para scaling (ROI=${roiPct.toFixed(1)}%, delivery=${(deliveryRate*100).toFixed(0)}%)`,
        status_from: status, status_to: "scaling", roi_pct: roiPct, delivery_rate: deliveryRate, avg_cpa: avgCpa, dry_run: true,
      });
    } else {
      // Ajustar CPA conforme regras
      acted = await maybeAdjustCpa(admin, row, roiPct, deliveryRate, avgCpa, dryRun, userJwt, updates, status);
    }
    await persistFunnel(admin, row.id, updates);
    return acted;
  }

  // === Estado: scaling / advanced-scaling ===
  if (status === "scaling" || status === "advanced-scaling") {
    // Verifica estabilidade -> graduate
    const last7 = days.slice(-STABLE_DAYS);
    const spend7 = last7.reduce((s, d) => s + d.spend, 0);
    const net7 = last7.reduce((s, d) => s + d.netRev, 0);
    const roi7 = spend7 > 0 ? ((net7 - spend7) / spend7) * 100 : 0;
    if (last7.length >= STABLE_DAYS && roi7 > 0 && deliveryRate >= SCALE_MIN_DELIVERY) {
      updates.funnel_status = "graduated";
      updates.graduated_at = now.toISOString();
      updates.stable_started_at = now.toISOString();
      updates.next_action_hint = "Graduada — entregue à automação principal";
      await logFunnelAction(admin, row, {
        action: "graduate",
        reason: `Estável: ROI7d=${roi7.toFixed(1)}%, delivery=${(deliveryRate*100).toFixed(0)}%`,
        status_from: status, status_to: "graduated",
        roi_pct: roi7, delivery_rate: deliveryRate, avg_cpa: avgCpa, dry_run: true,
      });
      // Habilita automação principal
      await admin.from("campaign_automation").upsert({
        user_id: userId, campaign_id: campaignId,
        site_id: row.site_id, google_account_id: row.google_account_id,
        lifecycle_status: "scaling",
        last_evaluated_at: now.toISOString(),
      }, { onConflict: "user_id,campaign_id" });
      await persistFunnel(admin, row.id, updates);
      return true;
    }

    // Cooldown de escala
    const cooldownUntil = row.cooldown_scale_until ? new Date(row.cooldown_scale_until) : null;
    const inCooldown = cooldownUntil && cooldownUntil > now;

    // Advanced scaling: ROI>25% por 5d
    const last5 = days.slice(-ADV_SCALE_DAYS);
    const spend5 = last5.reduce((s, d) => s + d.spend, 0);
    const net5 = last5.reduce((s, d) => s + d.netRev, 0);
    const roi5 = spend5 > 0 ? ((net5 - spend5) / spend5) * 100 : 0;
    const advanced = last5.length >= ADV_SCALE_DAYS && roi5 >= ADV_SCALE_MIN_ROI && deliveryRate >= ADV_SCALE_MIN_DELIVERY;

    if (advanced && !inCooldown) {
      // ROI alto + delivery saturado (≥90%) → só sobe budget, NÃO mexe no CPA
      const newBudget = budget * 1.20;
      acted = await apply("set_budget_absolute", { budget: Number(newBudget.toFixed(2)) },
        `Advanced scaling: ROI5d=${roi5.toFixed(1)}%, delivery=${(deliveryRate*100).toFixed(0)}% — +${SCALE_PCT}% budget`,
        "advanced-scaling", {
          current_budget: newBudget,
          last_scale_at: now.toISOString(),
          cooldown_scale_until: addDays(now, SCALE_COOLDOWN_DAYS).toISOString(),
          advanced_scaling_started_at: row.advanced_scaling_started_at ?? now.toISOString(),
        });
    } else if (!inCooldown && roiPct >= SCALE_MIN_ROI && deliveryRate >= SCALE_MIN_DELIVERY) {
      // Scaling normal +20%
      const newBudget = budget * 1.20;
      acted = await apply("set_budget_absolute", { budget: Number(newBudget.toFixed(2)) },
        `Scaling +${SCALE_PCT}%: ROI=${roiPct.toFixed(1)}%, delivery=${(deliveryRate*100).toFixed(0)}%`,
        "scaling", {
          current_budget: newBudget,
          last_scale_at: now.toISOString(),
          cooldown_scale_until: addDays(now, SCALE_COOLDOWN_DAYS).toISOString(),
        });
    } else {
      // Sem escalar: ajustar CPA se necessário
      acted = await maybeAdjustCpa(admin, row, roiPct, deliveryRate, avgCpa, dryRun, userJwt, updates, status);
      if (!acted) {
        updates.next_action_hint = inCooldown
          ? `Cooldown de escala até ${cooldownUntil!.toISOString().slice(0,10)}`
          : `Aguardando ROI≥${SCALE_MIN_ROI}% e delivery≥${SCALE_MIN_DELIVERY*100}%`;
      }
    }
    await persistFunnel(admin, row.id, updates);
    return acted;
  }

  // Default
  await persistFunnel(admin, row.id, updates);
  return false;
}

async function maybeAdjustCpa(admin: any, row: any, roiPct: number, deliveryRate: number, avgCpa: number, dryRun: boolean, userJwt: string | null, updates: any, status: string): Promise<boolean> {
  const now = new Date();
  const cpaCdUntil = row.cooldown_cpa_until ? new Date(row.cooldown_cpa_until) : null;
  if (cpaCdUntil && cpaCdUntil > now) return false;

  let deltaPct = 0;
  let reason = "";
  if (deliveryRate < 0.4) {
    deltaPct = CPA_UP_LOW_DELIVERY_PCT;
    reason = `Delivery baixo (${(deliveryRate*100).toFixed(0)}%) → +${deltaPct}% no CPA`;
  } else if (roiPct < 0 && deliveryRate >= 0.6) {
    deltaPct = CPA_UP_LOW_ROI_PCT;
    reason = `ROI caindo com delivery forte → +${deltaPct}% no CPA`;
  } else if (roiPct > 50 && deliveryRate > 0.8) {
    deltaPct = -5;
    reason = `ROI alto e delivery forte → ${deltaPct}% no CPA (forçar eficiência)`;
  } else {
    return false;
  }

  let error: string | null = null;
  let executed = false;
  if (!dryRun) {
    try {
      const r = await callMutate("adjust_cpa", {
        campaign_id: row.campaign_id, site_id: row.site_id, google_account_id: row.google_account_id, delta_pct: deltaPct,
      }, userJwt, row.user_id);
      if (r?.error) error = r.error; else executed = true;
    } catch (e) { error = String(e); }
  }
  await logFunnelAction(admin, row, {
    action: deltaPct > 0 ? "cpa_up" : "cpa_down",
    reason, status_from: status, status_to: status,
    roi_pct: roiPct, delivery_rate: deliveryRate, avg_cpa: avgCpa,
    dry_run: dryRun, error,
    payload: { delta_pct: deltaPct, executed },
  });
  Object.assign(updates, {
    last_cpa_change_at: now.toISOString(),
    cooldown_cpa_until: addDays(now, CPA_COOLDOWN_DAYS).toISOString(),
  });
  return executed || dryRun;
}

async function persistFunnel(admin: any, id: string, updates: any) {
  await admin.from("campaign_funnel").update(updates).eq("id", id);
}

async function logFunnelAction(admin: any, row: any, params: any) {
  await admin.from("campaign_funnel_logs").insert({
    user_id: row.user_id,
    funnel_id: row.id ?? null,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    site_id: row.site_id,
    google_account_id: row.google_account_id,
    status_from: params.status_from ?? row.funnel_status,
    status_to: params.status_to ?? row.funnel_status,
    action: params.action,
    reason: params.reason ?? null,
    roi_pct: params.roi_pct ?? null,
    delivery_rate: params.delivery_rate ?? null,
    avg_cpa: params.avg_cpa ?? null,
    budget_before: params.budget_before ?? row.current_budget ?? null,
    budget_after: params.budget_after ?? null,
    cpa_before: params.cpa_before ?? row.applied_target_cpa ?? null,
    cpa_after: params.cpa_after ?? null,
    dry_run: params.dry_run ?? true,
    payload: params.payload ?? null,
    error: params.error ?? null,
  });
}

async function callMutate(action: string, body: any, userJwt: string | null, userId: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userJwt) {
    headers["Authorization"] = `Bearer ${userJwt}`;
  } else {
    headers["Authorization"] = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`;
    headers["x-system-user-id"] = userId;
  }
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action, ...body }) });
  return await r.json().catch(() => ({}));
}

function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
