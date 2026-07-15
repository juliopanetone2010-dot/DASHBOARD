// Cron diário (e trigger manual) da esteira inteligente de campanhas.
// - Lê daily_metrics (já populado por google-ads-sync-campaigns + gam-sync-revenue)
// - Calcula ROI do dia atual com NET_FACTOR (mesma lógica do dashboard)
// - Classifica em: testing | learning | standby | scaling | bad | paused
// - Decide ação (pause | scale | cpa_up | cpa_down | none) respeitando cooldowns
// - Executa SOMENTE para pares site_id + google_account_id habilitados em site_automation_config
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const NET_FACTOR = 0.935;
const DEFAULT_STOPLOSS_ROI = -20;

type Lifecycle =
  | "testing" | "learning" | "standby" | "scaling" | "bad" | "paused"
  | "winner_test" | "winner_scaling" | "winner_standby" | "winner_paused";

// ROI da esteira: sempre o dia atual. Configurações de dias ficam só para
// regras legadas/cooldowns, não para o número mostrado na coluna ROI.
const DEFAULT_ANALYSIS_DAYS = 15;
const MAX_ANALYSIS_WINDOW = 30;
// Regras específicas do fluxo winner (separadas da automação padrão)
const WINNER_TEST_DAYS = 7;          // janela de aprendizado pós-ativação
const WINNER_SCALE_INTERVAL_DAYS = 2; // intervalo entre +20%
const WINNER_SCALE_PCT = 20;          // percentual por escala
const WINNER_DELIVERY_MIN = 0.7;      // >70% de delivery
function resolveAnalysisDays(cfg: any): number {
  const v = Number(cfg?.auto_analysis_days);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_ANALYSIS_DAYS;
  return Math.max(2, Math.min(MAX_ANALYSIS_WINDOW, Math.round(v)));
}

function isWinnerLifecycle(lc: Lifecycle | null | undefined): boolean {
  return typeof lc === "string" && lc.startsWith("winner_");
}
type SiteAutomationConfig = {
  id: string;
  user_id: string;
  site_id: string;
  google_account_id: string;
  automation_enabled: boolean;
  automation_dry_run: boolean;
  // Set automatically by trg_set_site_automation_enabled_at when automation_enabled
  // first becomes true; cleared when automation is disabled. Used by the trust
  // period gate below to keep newly enabled automation in dry-run for N days.
  automation_enabled_at: string | null;
};

// Trust period: when automation is freshly enabled for a (site, account) pair,
// the system keeps it in dry-run mode for this many days no matter what the
// user's automation_dry_run flag says. Gives the operator and the engine time
// to observe real behaviour under live data before any mutations are issued.
// 14 days picked because it covers two full weekly campaign cycles + GAM's
// historical-amend window. Tunable here without a migration.
const TRUST_PERIOD_DAYS = 14;

// Soft pause: when the engine pauses a campaign, we don't treat it as a
// permanent action. The campaign is marked pending_review for this many hours,
// after which one automatic resume is attempted ("second chance after pause").
// If the campaign gets paused again, state moves to 'exhausted_auto' and the
// engine stops trying — a human has to step in. 48h matches GAM's typical
// consolidation lag plus a full business day to see fresh revenue patterns.
const AUTO_PAUSE_REVIEW_HOURS = 48;
const AUTO_PAUSE_MAX_RESUMES = 1;

interface TrustPeriodState {
  inPeriod: boolean;
  enabledAt: string | null;
  daysRemaining: number;
  reason: "trust_period" | null;
}

function evaluateTrustPeriod(enabledAt: string | null): TrustPeriodState {
  if (!enabledAt) {
    // Defensive: shouldn't happen for an enabled row given the DB trigger, but
    // if it does we treat it as "still in trust period" — fail safe.
    return { inPeriod: true, enabledAt: null, daysRemaining: TRUST_PERIOD_DAYS, reason: "trust_period" };
  }
  const enabledMs = new Date(enabledAt).getTime();
  if (!Number.isFinite(enabledMs)) {
    return { inPeriod: true, enabledAt, daysRemaining: TRUST_PERIOD_DAYS, reason: "trust_period" };
  }
  const ageDays = (Date.now() - enabledMs) / 86_400_000;
  const inPeriod = ageDays < TRUST_PERIOD_DAYS;
  return {
    inPeriod,
    enabledAt,
    daysRemaining: inPeriod ? Math.max(0, Math.ceil(TRUST_PERIOD_DAYS - ageDays)) : 0,
    reason: inPeriod ? "trust_period" : null,
  };
}

// =============================================================================
// Circuit breaker — caps the number of pause mutations a single automation run
// can apply. If the engine decides to pause more than DEFAULT_MAX_PAUSES_PER_RUN
// campaigns, that almost always means upstream data is bad (GAM not synced,
// schema regression, etc.) and the run would do more damage than good. We let
// the first N pauses through, then trip; subsequent pause attempts throw and
// are logged as failed_circuit_breaker. Non-pause actions (scale, cpa_up,
// cpa_down) remain unaffected — those are reversible and low-stakes.
const DEFAULT_MAX_PAUSES_PER_RUN = 3;

interface RunBreaker {
  pausesApplied: number;
  maxPauses: number;
  tripped: boolean;
  trippedAt: string | null;
}

function makeRunBreaker(maxPauses: number): RunBreaker {
  return {
    pausesApplied: 0,
    maxPauses: Math.max(1, Math.floor(maxPauses)),
    tripped: false,
    trippedAt: null,
  };
}

class CircuitBreakerTrippedError extends Error {
  constructor(public readonly breaker: RunBreaker) {
    super(`circuit_breaker_tripped: pauses_applied=${breaker.pausesApplied} max=${breaker.maxPauses}`);
    this.name = "CircuitBreakerTrippedError";
  }
}

function resolveMaxPauses(cfg: any): number {
  const v = Number(cfg?.auto_max_pauses_per_run);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MAX_PAUSES_PER_RUN;
  return Math.max(1, Math.min(50, Math.round(v)));
}

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
  const userDryRun: boolean = cfg.automation_dry_run !== false;
  // Trust period: if automation was first enabled for this (site, account)
  // pair less than TRUST_PERIOD_DAYS ago, force dry-run regardless of the
  // user's setting. This is non-overridable from the UI; the user must wait
  // out the period OR (if needed) lower TRUST_PERIOD_DAYS in code.
  const trust = evaluateTrustPeriod(siteCfg.automation_enabled_at);
  const dryRun: boolean = userDryRun || trust.inPeriod;
  const dryRunReason: "user_config" | "trust_period" | null = userDryRun
    ? "user_config"
    : (trust.inPeriod ? "trust_period" : null);
  // Per-run circuit breaker. Caps live pause mutations; in dry-run mode the
  // breaker still tracks intent so the post-run summary can warn the operator
  // that the threshold *would* have been hit.
  const breaker = makeRunBreaker(resolveMaxPauses(cfg));

  // One-time log per run: surface the trust-period status so the operator can
  // see "we're still in the observation window, next live run in N days" at a
  // glance from the audit log without having to parse per-campaign rows.
  if (trust.inPeriod) {
    await admin.from("automation_logs").insert({
      user_id: userId,
      site_id: siteId,
      google_account_id: accountId,
      campaign_id: null,
      action: "trust_period",
      reason: `Período de observação ativo: faltam ${trust.daysRemaining} dia(s) para a automação operar em modo live (forçando dry-run).`,
      decision: "dry_run_forced",
      payload: {
        trust_period_days: TRUST_PERIOD_DAYS,
        automation_enabled_at: trust.enabledAt,
        days_remaining: trust.daysRemaining,
        user_dry_run_setting: userDryRun,
      },
    });
  }

  // Soft-pause auto-revert phase: BEFORE the main decision loop. Walks the
  // queue of campaigns that the engine paused 48h+ ago and either resumes
  // them (one-shot) or marks them exhausted_auto for human review. Reasons:
  //   - placing this BEFORE main loop means a resumed campaign re-enters the
  //     normal evaluation as ENABLED, ready to participate in scaling/CPA
  //     decisions if its data has improved;
  //   - paused campaigns have no recent spend and would be skipped by the
  //     main loop anyway, so without this phase they'd be stuck forever.
  const reviewResult = await processPendingReviews({
    admin, userId, siteId, accountId, dryRun, userJwt,
  });
  // Busca histórico suficiente para regras de segurança, mas o ROI exibido e
  // usado na classificação principal é o do dia atual.
  const days: number = resolveAnalysisDays(cfg);

  const today = new Date();
  const from = new Date(today); from.setUTCDate(today.getUTCDate() - Math.max(0, days - 1));
  const fromIso = isoDate(from);
  const toIso = isoDate(today);

  const { data: link } = await admin
    .from("account_site_links")
    .select("id")
    .eq("user_id", userId)
    .eq("site_id", siteId)
    .eq("google_account_id", accountId)
    .maybeSingle();
  if (!link) return { window: { from: fromIso, to: toIso }, dry_run: dryRun, dry_run_reason: dryRunReason, trust_period: { in_period: trust.inPeriod, days_remaining: trust.daysRemaining }, skipped: "site_account_not_linked" };

  // Garante que budget_micros e target_cpa_micros estão atualizados antes de decidir.
  // Sem isso, delivery_ratio fica null e a automação não consegue tomar ações de CPA/scale.
  const budgetSync = await syncCampaignBudgets(admin, userId, accountId);
  const strategyByCamp: Map<string, { strategyType: string; targetCpaMicros: number | null }> =
    (budgetSync as any).strategyByCamp ?? new Map();

  // SAFEGUARD #1 — Antes de ler daily_metrics, força sincronização da receita GAM
  // dos últimos `days` dias. Sem isto a automação pode rodar sobre dias com
  // revenue=0 (ainda não sincronizado) e calcular ROI=-100%, pausando campanhas boas.
  const revenueSync = await syncGamRevenueWindow(userId, siteId, fromIso, toIso);

  const { data: metrics } = await admin
    .from("daily_metrics")
    .select("campaign_id, google_account_id, date, spend, profit, clicks, conversions, impressions, revenue")
    .eq("user_id", userId)
    .eq("google_account_id", accountId)
    .gte("date", fromIso)
    .lte("date", toIso)
    .limit(50000);

  const byCamp = new Map<string, {
    campaign_id: string; google_account_id: string;
    spend: number; grossRevBrl: number; days: Set<string>;
    daily: { date: string; spend: number; profit: number; roi: number }[];
    skippedUnsyncedDays: number;
  }>();
  for (const r of metrics ?? []) {
    const cid = String(r.campaign_id);
    let agg = byCamp.get(cid);
    if (!agg) { agg = { campaign_id: cid, google_account_id: accountId, spend: 0, grossRevBrl: 0, days: new Set(), daily: [], skippedUnsyncedDays: 0 }; byCamp.set(cid, agg); }
    const spend = Number(r.spend) || 0;
    const profit = Number(r.profit) || 0;
    const revenue = Number(r.revenue) || 0;

    // SAFEGUARD #2 — Dia com gasto > 0 mas receita=0 e profit=-spend é dia
    // ainda NÃO sincronizado pelo GAM. Tratar como ROI=-100% pausaria campanhas
    // saudáveis. Ignoramos esses dias do agregado (não entram em spend/revenue/days).
    const isUnsynced = spend > 0 && revenue <= 0 && Math.abs(profit + spend) < 0.01;
    if (isUnsynced) {
      agg.skippedUnsyncedDays++;
      continue;
    }

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

  // Campanhas com fluxo de reinício ativo são geridas apenas pelo `campaign-restart`.
  const { data: restartFlows } = await admin
    .from("campaign_restart_flow")
    .select("campaign_id, stage")
    .eq("user_id", userId)
    .eq("status", "active");
  const restartActiveSet = new Set<string>((restartFlows ?? []).map((r: any) => String(r.campaign_id)));
  const restartStageByCamp = new Map<string, string>();
  for (const r of restartFlows ?? []) restartStageByCamp.set(String(r.campaign_id), String(r.stage ?? ""));
  // Mapeia stage do restart_flow para lifecycle_status para manter UI sincronizada
  const stageToLifecycle = (stage: string): Lifecycle => {
    if (stage.includes("phase2") || stage.includes("phase3") || stage.includes("phase4")) return "scaling";
    return "testing";
  };
  const stageToLastAction = (stage: string): string => {
    if (stage.includes("phase1")) return "restart_phase1_testing";
    if (stage.includes("phase2")) return "restart_phase2_scale";
    if (stage.includes("phase3")) return "restart_phase3_scale";
    if (stage.includes("phase4")) return "restart_phase4_full";
    return "restart_in_progress";
  };

  // Campanhas no Funil Inteligente são isoladas: automation-run não toca.
  const { data: funnelRows } = await admin
    .from("campaign_funnel")
    .select("campaign_id, funnel_status")
    .eq("user_id", userId)
    .not("funnel_status", "in", "(graduated,failed-learning)");
  const funnelLockedSet = new Set<string>((funnelRows ?? []).map((r: any) => String(r.campaign_id)));

  const { data: campRows } = await admin
    .from("campaigns")
    .select("campaign_id, name, status, google_account_id, budget_micros")
    .eq("user_id", userId)
    .eq("google_account_id", accountId);
  const campMeta = new Map<string, any>();
  for (const c of campRows ?? []) campMeta.set(String(c.campaign_id), c);

  let decisions = 0; let executed = 0; let skippedInactive = 0; let skippedSiteMismatch = 0; let skippedAmbiguousSite = 0; let skippedRestartFlow = 0; let skippedFunnel = 0;
  for (const agg of byCamp.values()) {
    const meta = campMeta.get(agg.campaign_id);
    const status = String(meta?.status ?? "").toLowerCase();
    if (!meta || (status !== "enabled" && status !== "active")) {
      skippedInactive++;
      continue;
    }

    if (restartActiveSet.has(agg.campaign_id)) {
      // Espelha o estágio do restart_flow no lifecycle_status para que a UI não fique presa em "paused"
      const stage = restartStageByCamp.get(agg.campaign_id) ?? "";
      const desiredLifecycle = stageToLifecycle(stage);
      const desiredLastAction = stageToLastAction(stage);
      const prev = stateByCamp.get(agg.campaign_id);
      const isStuckOnRestart = prev?.last_action === "removed_for_restart";
      if (!prev || prev.lifecycle_status !== desiredLifecycle || isStuckOnRestart) {
        await admin.from("campaign_automation").upsert({
          user_id: userId,
          campaign_id: agg.campaign_id,
          google_account_id: accountId,
          site_id: siteId,
          lifecycle_status: desiredLifecycle,
          last_action: desiredLastAction,
          last_evaluated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,site_id,google_account_id,campaign_id" });
      }
      skippedRestartFlow++;
      continue;
    }

    if (funnelLockedSet.has(agg.campaign_id)) {
      skippedFunnel++;
      continue;
    }

    // Lock da engine "Destravar Escala" — não tocar enquanto observação dela estiver ativa
    const _suLock = stateByCamp.get(agg.campaign_id)?.scale_unlock_locked_until;
    if (_suLock && new Date(_suLock).getTime() > Date.now()) {
      skippedFunnel++;
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
    const prevState = stateByCamp.get(agg.campaign_id);
    const fromStatus: Lifecycle | null = prevState?.lifecycle_status ?? null;

    // === PROTEÇÃO CONTRA RE-PAUSA APÓS REATIVAÇÃO MANUAL ===
    // Se a automação pausou antes (auto_paused_at) e a campanha agora está
    // ENABLED sem termos sido nós (auto_pause_state != 'auto_resumed'),
    // significa que o usuário reativou manualmente. Marca como 'manual_resumed'
    // para bloquear novas pausas até o usuário pausar manualmente de novo.
    if (
      prevState?.auto_paused_at &&
      prevState?.auto_pause_state !== "auto_resumed" &&
      prevState?.auto_pause_state !== "manual_resumed"
    ) {
      await admin
        .from("campaign_automation")
        .update({
          auto_pause_state: "manual_resumed",
          auto_pause_resumed_at: new Date().toISOString(),
          auto_pause_review_at: null,
        })
        .eq("user_id", userId)
        .eq("campaign_id", agg.campaign_id);
      await admin.from("automation_logs").insert({
        user_id: userId, site_id: siteId, google_account_id: accountId,
        campaign_id: agg.campaign_id,
        action: "manual_resume_detected",
        decision: "protected",
        reason: "Usuário reativou a campanha manualmente após pausa automática — proteção contra nova pausa ativada.",
      });
      if (prevState) prevState.auto_pause_state = "manual_resumed";
    }
    const manuallyResumedProtected = prevState?.auto_pause_state === "manual_resumed";


    // Campanhas em MAXIMIZE_CONVERSIONS sem target_cpa: fase de aprendizado.
    // Regra:
    //  - Por até 5 dias com spend > 0, automação não toca (deixa aprender).
    //  - A partir do 5º dia, avalia ROI dos últimos 5 dias:
    //      • ROI <= -15%  → continua protegida (não mexer; usuário decide).
    //      • ROI > -15%   → aplica target_cpa = média de CPA dos 5 dias.
    //      • Se ROI > 0%  → também inscreve no Funil Inteligente para escalar.
    const strat = strategyByCamp.get(agg.campaign_id);
    const isMaxConvNoTarget =
      strat &&
      String(strat.strategyType).toUpperCase().includes("MAXIMIZE_CONVERSIONS") &&
      (!strat.targetCpaMicros || strat.targetCpaMicros <= 0);
    if (isMaxConvNoTarget && !isWinnerLifecycle(fromStatus)) {
      // Busca o último restart desta campanha para garantir que o janelamento de 5 dias
      // só conte dias APÓS o reinício (evita misturar dados pré/pós restart).
      const { data: lastRestart } = await admin
        .from("campaign_restart_flow")
        .select("start_date")
        .eq("user_id", userId)
        .eq("campaign_id", agg.campaign_id)
        .order("start_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const restartDate = lastRestart?.start_date ? isoDate(new Date(lastRestart.start_date)) : null;
      const fiveDaysAgoDate = isoDate(new Date(Date.now() - 5 * 86400_000));
      // Usa o mais recente entre (hoje-5d) e (data do último restart)
      const windowStart = restartDate && restartDate > fiveDaysAgoDate ? restartDate : fiveDaysAgoDate;
      const { data: dm5 } = await admin
        .from("daily_metrics")
        .select("date, spend, conversions, revenue")
        .eq("user_id", userId)
        .eq("campaign_id", agg.campaign_id)
        .gte("date", windowStart)
        .order("date", { ascending: false });
      const rows5 = (dm5 ?? []).filter((r: any) => Number(r.spend) > 0);
      const daysActive = rows5.length;
      let s5 = 0, c5 = 0, rev5 = 0;
      for (const r of rows5) {
        s5 += Number(r.spend) || 0;
        c5 += Number(r.conversions) || 0;
        rev5 += Number(r.revenue) || 0;
      }
      const roi5 = s5 > 0 ? (((rev5 * NET_FACTOR) - s5) / s5) * 100 : 0;
      const avgCpa = c5 > 0 ? s5 / c5 : 0;

      if (daysActive < 5) {
        await admin.from("automation_logs").insert({
          user_id: userId, site_id: siteId, google_account_id: accountId,
          campaign_id: agg.campaign_id,
          action: "classify",
          reason: `MAX_CONV em aprendizado (${daysActive}/5 dias com spend) → não atuar.`,
          decision: "skipped",
          payload: { name: meta?.name ?? null, days_active: daysActive, roi_5d: round2(roi5) },
        });
        continue;
      }

      if (roi5 <= -15) {
        await admin.from("automation_logs").insert({
          user_id: userId, site_id: siteId, google_account_id: accountId,
          campaign_id: agg.campaign_id,
          action: "classify",
          reason: `MAX_CONV 5d com ROI ${round2(roi5)}% (<= -15%) → manter protegida; revisar manualmente.`,
          decision: "skipped",
          payload: { name: meta?.name ?? null, days_active: daysActive, roi_5d: round2(roi5), spend_5d: round2(s5), conv_5d: c5, avg_cpa: round2(avgCpa) },
        });
        continue;
      }

      if (avgCpa <= 0) {
        await admin.from("automation_logs").insert({
          user_id: userId, site_id: siteId, google_account_id: accountId,
          campaign_id: agg.campaign_id,
          action: "classify",
          reason: `MAX_CONV 5d ROI ${round2(roi5)}% mas sem conversões → manter protegida.`,
          decision: "skipped",
          payload: { name: meta?.name ?? null, days_active: daysActive, spend_5d: round2(s5), conv_5d: c5 },
        });
        continue;
      }

      const targetCpa = Math.round(avgCpa * 100) / 100;
      let applyOk = false;
      let applyErr: string | null = null;
      if (!dryRun) {
        try {
          const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (userJwt) headers.Authorization = `Bearer ${userJwt}`;
          else { headers.Authorization = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`; headers["x-system-user-id"] = userId; }
          const r = await fetch(url, {
            method: "POST", headers,
            body: JSON.stringify({
              action: "set_target_cpa",
              campaign_id: agg.campaign_id,
              google_account_id: accountId,
              site_id: siteId,
              target_cpa: targetCpa,
            }),
          });
          const j = await r.json().catch(() => ({}));
          applyOk = r.ok && !j?.error;
          applyErr = j?.error ?? null;
        } catch (e) {
          applyErr = String(e);
        }
      }
      await admin.from("automation_logs").insert({
        user_id: userId, site_id: siteId, google_account_id: accountId,
        campaign_id: agg.campaign_id,
        action: "set_target_cpa",
        reason: `MAX_CONV 5d ROI ${round2(roi5)}% (> -15%) → aplicando target_cpa = R$ ${targetCpa.toFixed(2)} (média 5d: spend ${s5.toFixed(2)} / conv ${c5})`,
        decision: dryRun ? "dry_run" : (applyOk ? "executed" : "failed"),
        cost: round2(s5), revenue: round2(rev5), roi: round2(roi5),
        payload: { name: meta?.name ?? null, avg_cpa: avgCpa, spend_5d: s5, conv_5d: c5, roi_5d: round2(roi5), days_active: daysActive },
        error: applyErr,
      });

      if (roi5 > 0 && (applyOk || dryRun)) {
        try {
          const { data: existingFunnel } = await admin
            .from("campaign_funnel")
            .select("id, funnel_status")
            .eq("user_id", userId)
            .eq("campaign_id", agg.campaign_id)
            .maybeSingle();
          if (!existingFunnel || ["graduated", "failed-learning"].includes(String(existingFunnel.funnel_status))) {
            if (!dryRun) {
              await admin.from("campaign_funnel").upsert({
                user_id: userId,
                site_id: siteId,
                google_account_id: accountId,
                campaign_id: agg.campaign_id,
                campaign_name: meta?.name ?? null,
                funnel_status: "scaling",
                entry_source: "automation_max_conv_graduate",
                applied_target_cpa: targetCpa,
                current_budget: dailyBudget,
                last_roi_pct: round2(roi5),
                avg_cpa_5d: avgCpa,
                last_evaluated_at: new Date().toISOString(),
              }, { onConflict: "user_id,campaign_id" });
            }
            await admin.from("automation_logs").insert({
              user_id: userId, site_id: siteId, google_account_id: accountId,
              campaign_id: agg.campaign_id,
              action: "enroll_funnel",
              reason: `ROI 5d ${round2(roi5)}% positivo após target_cpa → inscrita no Funil Inteligente para escalar.`,
              decision: dryRun ? "dry_run" : "executed",
              roi: round2(roi5),
              payload: { name: meta?.name ?? null, target_cpa: targetCpa },
            });
          }
        } catch (e) {
          await admin.from("automation_logs").insert({
            user_id: userId, site_id: siteId, google_account_id: accountId,
            campaign_id: agg.campaign_id,
            action: "enroll_funnel",
            reason: `Falha ao inscrever no Funil Inteligente`,
            decision: "failed",
            error: String(e),
          });
        }
      }
      continue;
    }
    // (bloco antigo desativado — mantido como referência)
    if (false && isMaxConvNoTarget) {
      const last7 = (agg.daily as any[])
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 7);
      let totSpend = 0; let totConv = 0;
      for (const d of last7) {
        totSpend += Number(d.spend) || 0;
        totConv += Number((d as any).conversions) || 0;
      }
      // conversions não está no agg.daily — buscar direto do daily_metrics
      const sevenDaysAgo = isoDate(new Date(Date.now() - 7 * 86400_000));
      const { data: convRows } = await admin
        .from("daily_metrics")
        .select("spend, conversions")
        .eq("user_id", userId)
        .eq("campaign_id", agg.campaign_id)
        .gte("date", sevenDaysAgo);
      let s2 = 0; let c2 = 0;
      for (const r of convRows ?? []) {
        s2 += Number(r.spend) || 0;
        c2 += Number(r.conversions) || 0;
      }
      const avgCpa = c2 > 0 ? s2 / c2 : 0;
      if (avgCpa > 0) {
        if (!dryRun) {
          try {
            const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (userJwt) headers.Authorization = `Bearer ${userJwt}`;
            else { headers.Authorization = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`; headers["x-system-user-id"] = userId; }
            const r = await fetch(url, {
              method: "POST", headers,
              body: JSON.stringify({
                action: "set_target_cpa",
                campaign_id: agg.campaign_id,
                google_account_id: accountId,
                site_id: siteId,
                target_cpa: Math.round(avgCpa * 100) / 100,
              }),
            });
            const j = await r.json().catch(() => ({}));
            await admin.from("automation_logs").insert({
              user_id: userId, site_id: siteId, google_account_id: accountId,
              campaign_id: agg.campaign_id,
              action: "set_target_cpa",
              reason: `MAXIMIZE_CONVERSIONS sem target_cpa → aplicando média 7d = R$ ${avgCpa.toFixed(2)} (spend ${s2.toFixed(2)} / conv ${c2})`,
              decision: r.ok && !j?.error ? "executed" : "failed",
              cost: round2(s2), revenue: null, roi: null,
              payload: { avg_cpa: avgCpa, spend_7d: s2, conv_7d: c2 },
              error: j?.error ?? null,
            });
          } catch (e) {
            await admin.from("automation_logs").insert({
              user_id: userId, site_id: siteId, google_account_id: accountId,
              campaign_id: agg.campaign_id,
              action: "set_target_cpa", reason: `MAXIMIZE_CONVERSIONS sem target_cpa`,
              decision: "failed", error: String(e),
            });
          }
        } else {
          await admin.from("automation_logs").insert({
            user_id: userId, site_id: siteId, google_account_id: accountId,
            campaign_id: agg.campaign_id,
            action: "set_target_cpa",
            reason: `[dry-run] MAXIMIZE_CONVERSIONS sem target_cpa → aplicaria R$ ${avgCpa.toFixed(2)} (média 7d)`,
            decision: "dry_run",
            payload: { avg_cpa: avgCpa, spend_7d: s2, conv_7d: c2 },
          });
        }
      }
    }


    // ===== RAMO WINNER (isolado da automação padrão) =====
    if (isWinnerLifecycle(fromStatus)) {
      const result = await runWinnerCycle({
        admin, userId, siteId, accountId, agg, meta, prevState, dailyBudget, dryRun, userJwt,
      });
      decisions++;
      if (result.executed) executed++;
      continue;
    }

    const decision = classify(agg, cfg, prevState, dailyBudget) as any;
    // Garante que roi_today está sempre disponível (alguns branches do classify não anexam).
    const todayIsoCaller = new Date().toISOString().slice(0, 10);
    const todayDailyCaller = (agg.daily as any[]).find((d) => d.date === todayIsoCaller);
    if (todayDailyCaller) {
      const tCost = Number(todayDailyCaller.spend) || 0;
      const tGross = tCost + (Number(todayDailyCaller.profit) || 0);
      decision.roi_today = tCost > 0 ? (((tGross * NET_FACTOR) - tCost) / tCost) * 100 : null;
    } else if (decision.roi_today === undefined) {
      decision.roi_today = null;
    }
    decisions++;

    const nowIso = new Date().toISOString();
    const newState: any = {
      user_id: userId,
      site_id: siteId,
      campaign_id: agg.campaign_id,
      google_account_id: accountId,
      lifecycle_status: decision.lifecycle,
      last_roi: round2(decision.roi),
      roi_today: (decision as any).roi_today == null ? null : round2((decision as any).roi_today),
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
    // Histerese do "Escalando": persiste o contador de dias abaixo do piso
    // e marca scaling_since na primeira vez que entra em Escalando.
    if (decision.lifecycle === "scaling") {
      newState.scaling_since = prevState?.scaling_since ?? nowIso;
      newState.sub_threshold_days = Number((decision as any).sub_threshold_days ?? 0);
    } else {
      newState.scaling_since = null;
      newState.sub_threshold_days = 0;
    }
    // Segunda chance (stop-loss): set/clear/preserve.
    const scDecision = (decision as any).second_chance_started_at;
    if (scDecision !== undefined) {
      newState.second_chance_started_at = scDecision; // string ou null
      newState.second_chance_reason = scDecision ? decision.reason : null;
    } else if (prevState?.second_chance_started_at && Number(decision.roi) >= 0) {
      // ROI recuperou — limpa flag mesmo fora do bloco de stop-loss.
      newState.second_chance_started_at = null;
      newState.second_chance_reason = null;
    }
    let execStatus: "executed" | "dry_run" | "skipped" | "pending_approval" | "failed" | "failed_circuit_breaker" = "dry_run";
    let execError: string | null = null;
    if (decision.action === "pause" && manuallyResumedProtected) {
      execStatus = "skipped";
      await admin.from("automation_logs").insert({
        user_id: userId, site_id: siteId, google_account_id: accountId,
        campaign_id: agg.campaign_id,
        action: "pause_blocked_manual_resume",
        decision: "protected",
        reason: `Pausa bloqueada: usuário reativou esta campanha manualmente após pausa automática. Decisão original: ${decision.reason ?? ""}`,
        roi: Number.isFinite(decision.roi) ? round2(decision.roi) : null,
      });
    } else if (decision.action !== "none") {

      if (dryRun) {
        // In dry-run we still track pause intent against the breaker so the
        // post-run summary can warn the operator about how the live run would
        // have behaved without ever issuing a real mutation.
        if (decision.action === "pause") {
          if (breaker.tripped || breaker.pausesApplied >= breaker.maxPauses) {
            breaker.tripped = true;
            breaker.trippedAt = breaker.trippedAt ?? new Date().toISOString();
          } else {
            breaker.pausesApplied++;
          }
        }
        execStatus = "dry_run";
      } else if (decision.action === "pause") {
        const recentRejectionSince = new Date(Date.now() - 24 * 3600_000).toISOString();
        const { data: existingApproval } = await admin
          .from("automation_actions")
          .select("id, status, created_at")
          .eq("user_id", userId)
          .eq("campaign_id", agg.campaign_id)
          .eq("action_type", "auto_pause_review")
          .in("status", ["pending", "rejected"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const recentlyRejected = existingApproval?.status === "rejected" && String(existingApproval.created_at) >= recentRejectionSince;
        if (!existingApproval || (existingApproval.status === "rejected" && !recentlyRejected)) {
          await admin.from("automation_actions").insert({
            user_id: userId,
            campaign_id: agg.campaign_id,
            action_type: "auto_pause_review",
            reason: decision.reason,
            status: "pending",
            payload: {
              name: meta?.name ?? null,
              site_id: siteId,
              google_account_id: accountId,
              roi: Number.isFinite(decision.roi) ? round2(decision.roi) : null,
              roi_today: (decision as any).roi_today == null ? null : round2((decision as any).roi_today),
              trend: decision.trend ?? null,
              delivery_ratio: decision.delivery == null ? null : round2(decision.delivery),
              spend: round2(agg.spend),
              source: "automation-run",
            },
          });
        }
        execStatus = recentlyRejected ? "skipped" : "pending_approval";
      } else {
        try {
          await applyMutation(userJwt, userId, agg.campaign_id, accountId, siteId, decision, cfg, breaker);
          execStatus = "executed"; executed++;
        } catch (e) {
          if (e instanceof CircuitBreakerTrippedError) {
            execStatus = "failed_circuit_breaker";
            execError = e.message;
          } else {
            execStatus = "failed";
            execError = String(e instanceof Error ? e.message : e);
          }
        }
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
      // Soft-pause bookkeeping. When the engine actually pauses a campaign,
      // record everything the auto-revert phase will need to evaluate it 48h
      // later. We DO NOT set these fields in dry-run (the campaign wasn't
      // really paused) or on circuit-breaker-blocked attempts.
      if (decision.action === "pause") {
        newState.auto_paused_at = nowIso;
        newState.auto_paused_reason = decision.reason ?? null;
        newState.auto_pause_review_at = new Date(Date.now() + AUTO_PAUSE_REVIEW_HOURS * 3600_000).toISOString();
        newState.auto_pause_state = "pending_review";
        newState.auto_pause_snapshot = {
          roi: Number.isFinite(decision.roi) ? round2(decision.roi) : null,
          roi_today: (decision as any).roi_today == null ? null : round2((decision as any).roi_today),
          trend: decision.trend ?? null,
          delivery: decision.delivery == null ? null : round2(decision.delivery),
          spend: round2(agg.spend),
          days_evaluated: agg.days.size,
          daily_budget: round2(dailyBudget),
          at: nowIso,
        };
      }
      newState.last_action = decision.action;
      newState.last_action_date = nowIso;
      if (decision.delivery_driven) {
        newState.last_delivery_action = decision.action;
        newState.last_delivery_action_date = nowIso;
      }
    }

    await admin.from("campaign_automation").upsert(newState, { onConflict: "user_id,site_id,google_account_id,campaign_id" });

    // Auto-enroll no Funil Inteligente quando a automação fez scale com ROI saudável.
    // Após inscrita, o funnel_isolation impede que a automação principal toque na campanha
    // até que ela vire "graduated" ou "failed-learning".
    if (execStatus === "executed" && decision.action === "scale" && Number(decision.roi) >= 20) {
      try {
        const { data: existingFunnel } = await admin
          .from("campaign_funnel")
          .select("id, funnel_status")
          .eq("user_id", userId)
          .eq("campaign_id", agg.campaign_id)
          .maybeSingle();
        if (!existingFunnel || ["graduated", "failed-learning"].includes(String(existingFunnel.funnel_status))) {
          const targetCpaFromMeta = meta?.target_cpa_micros ? Number(meta.target_cpa_micros) / 1_000_000 : null;
          await admin.from("campaign_funnel").upsert({
            user_id: userId,
            site_id: siteId,
            google_account_id: accountId,
            campaign_id: agg.campaign_id,
            campaign_name: meta?.name ?? null,
            funnel_status: "scaling",
            entry_source: "automation_scale_handoff",
            applied_target_cpa: targetCpaFromMeta,
            current_budget: dailyBudget,
            last_roi_pct: round2(decision.roi),
            last_evaluated_at: new Date().toISOString(),
          }, { onConflict: "user_id,campaign_id" });
          await admin.from("automation_logs").insert({
            user_id: userId, site_id: siteId, google_account_id: accountId,
            campaign_id: agg.campaign_id,
            action: "enroll_funnel",
            reason: `Scale executado com ROI ${round2(decision.roi)}% ≥ 20% → handoff para o Funil Inteligente.`,
            decision: "executed",
            roi: round2(decision.roi),
            payload: { name: meta?.name ?? null, target_cpa: targetCpaFromMeta, budget: dailyBudget },
          });
        }
      } catch (e) {
        await admin.from("automation_logs").insert({
          user_id: userId, site_id: siteId, google_account_id: accountId,
          campaign_id: agg.campaign_id,
          action: "enroll_funnel",
          reason: `Falha ao inscrever no Funil Inteligente após scale`,
          decision: "failed",
          error: String(e),
        });
      }
    }

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
        window_days: decision.window_days ?? null,
        daily: agg.daily.slice(-(decision.window_days ?? days)),
      },
      error: execError,
    });
  }

  const totalSkippedUnsynced = [...byCamp.values()].reduce((s, a) => s + (a.skippedUnsyncedDays || 0), 0);

  // Circuit breaker summary — surface as a top-level log row when the breaker
  // either tripped or applied any pauses, so the operator has a single audit
  // entry per run instead of having to scan per-campaign rows for the pattern.
  if (breaker.tripped || breaker.pausesApplied > 0) {
    await admin.from("automation_logs").insert({
      user_id: userId,
      site_id: siteId,
      google_account_id: accountId,
      campaign_id: null,
      action: "circuit_breaker",
      reason: breaker.tripped
        ? `Disjuntor disparado: ${breaker.pausesApplied}/${breaker.maxPauses} pausas aplicadas, demais bloqueadas.`
        : `Run encerrou com ${breaker.pausesApplied}/${breaker.maxPauses} pausas aplicadas (sem disparo).`,
      decision: breaker.tripped ? "tripped" : "ok",
      payload: {
        max_pauses_per_run: breaker.maxPauses,
        pauses_applied: breaker.pausesApplied,
        tripped: breaker.tripped,
        tripped_at: breaker.trippedAt,
        dry_run: dryRun,
      },
    });
  }

  return {
    window: { from: fromIso, to: toIso },
    dry_run: dryRun,
    dry_run_reason: dryRunReason,
    campaigns: byCamp.size,
    decisions, executed,
    skipped_inactive: skippedInactive,
    skipped_site_mismatch: skippedSiteMismatch,
    skipped_ambiguous_site: skippedAmbiguousSite,
    skipped_restart_flow: skippedRestartFlow,
    budget_sync: budgetSync,
    revenue_sync: revenueSync,
    skipped_unsynced_days: totalSkippedUnsynced,
    trust_period: {
      in_period: trust.inPeriod,
      days_remaining: trust.daysRemaining,
      enabled_at: trust.enabledAt,
      total_days: TRUST_PERIOD_DAYS,
    },
    circuit_breaker: {
      max_pauses: breaker.maxPauses,
      pauses_applied: breaker.pausesApplied,
      tripped: breaker.tripped,
      tripped_at: breaker.trippedAt,
    },
    auto_revert: {
      review_hours: AUTO_PAUSE_REVIEW_HOURS,
      max_resumes_per_campaign: AUTO_PAUSE_MAX_RESUMES,
      ...reviewResult,
    },
  };
}

// Sincroniza budget_micros e target_cpa_micros das campanhas direto do Google Ads,
// para que a automação tenha delivery_ratio confiável antes de decidir ações.
// SAFEGUARD — Força sincronização da receita GAM da janela analisada antes de
// qualquer decisão de automação. Evita que dias com revenue=0 (ainda não puxado
// do GAM) gerem ROI=-100% e pausem campanhas saudáveis.
async function syncGamRevenueWindow(userId: string, siteId: string, fromIso: string, toIso: string): Promise<{ ok: boolean; error?: string; ms?: number }> {
  const t0 = Date.now();
  try {
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/gam-sync-revenue`;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        sync: true,            // espera concluir (não roda em background)
        user_id: userId,
        site_id: siteId,
        from: fromIso,
        to: toIso,
        revenue_only: true,
        skip_viewability: false,
        skip_snapshot_regen: true,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `status ${res.status}: ${txt.slice(0, 200)}`, ms: Date.now() - t0 };
    }
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e), ms: Date.now() - t0 };
  }
}

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
             campaign.bidding_strategy_type,
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
    const strategyByCamp = new Map<string, { strategyType: string; targetCpaMicros: number | null }>();
    const updates = rows.map((r) => {
      const targetCpaMicros = r.campaign.targetCpa?.targetCpaMicros
        ? Number(r.campaign.targetCpa.targetCpaMicros)
        : (r.campaign.maximizeConversions?.targetCpaMicros ? Number(r.campaign.maximizeConversions.targetCpaMicros) : null);
      const strategyType = String(r.campaign.biddingStrategyType ?? "");
      strategyByCamp.set(String(r.campaign.id), { strategyType, targetCpaMicros });
      return {
        user_id: userId,
        google_account_id: accountId,
        campaign_id: String(r.campaign.id),
        name: r.campaign.name ?? `Campaign ${r.campaign.id}`,
        status: String(r.campaign.status ?? "enabled").toLowerCase(),
        budget_micros: r.campaignBudget?.amountMicros ? Number(r.campaignBudget.amountMicros) : null,
        target_cpa_micros: targetCpaMicros,
      };
    });
    let updated = 0;
    for (let i = 0; i < updates.length; i += 200) {
      const slice = updates.slice(i, i + 200);
      const { error } = await admin
        .from("campaigns")
        .upsert(slice, { onConflict: "user_id,google_account_id,campaign_id" });
      if (!error) updated += slice.length;
    }
    return { updated, strategyByCamp };
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
  window_days?: number;
} {
  // CLASSIFICAÇÃO usa a janela de N dias (auto_analysis_days), pra dar consistência
  // entre dias. A coluna "ROI" da esteira mostra o ROI de HOJE separadamente
  // (campo extra `roi_today`) — assim o usuário vê o de hoje sem que o status
  // pule de "scaling" pra "learning" só porque o dia de hoje variou.
  const prevLifecycle: Lifecycle = (prev?.lifecycle_status as Lifecycle) ?? "testing";
  const windowDays = resolveAnalysisDays(cfg);

  const sortedAll = [...agg.daily].sort((a, b) => a.date.localeCompare(b.date));
  const sliced = sortedAll.slice(-windowDays);
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayDaily = sortedAll.find((d: any) => d.date === todayIso) ?? null;
  const days = new Set(sliced.map((d: any) => d.date)).size;
  const cost = sliced.reduce((s: number, d: any) => s + (Number(d.spend) || 0), 0);
  const grossRevBrl = sliced.reduce((s: number, d: any) => s + ((Number(d.spend) || 0) + (Number(d.profit) || 0)), 0);
  const netRev = grossRevBrl * NET_FACTOR;
  const roi = cost > 0 ? ((netRev - cost) / cost) * 100 : 0;
  const todayCost = todayDaily ? Number(todayDaily.spend) || 0 : 0;
  const todayGrossRevBrl = todayDaily ? (Number(todayDaily.spend) || 0) + (Number(todayDaily.profit) || 0) : 0;
  const todayNetRev = todayGrossRevBrl * NET_FACTOR;
  const todayRoi = todayCost > 0 ? ((todayNetRev - todayCost) / todayCost) * 100 : null;
  const stopLossRoi = normalizeStopLossRoi(cfg.auto_stoploss_min_roi);
  const stopLossDays = Math.max(1, Number(cfg.auto_stoploss_days) || 7);
  const stopLossMinCost = Math.max(0, Number(cfg.auto_stoploss_min_cost) || 0);

  const sorted = sliced;
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

  // Mínimo de 2 dias E custo acumulado >= stoploss_min_cost para qualquer decisão.
  // Antes o gate usava custo de 1 dia, o que pausava campanhas com pouquíssimo
  // gasto recente. Agora respeita o auto_stoploss_min_cost no acumulado.
  if (days < Math.min(2, windowDays) || cost < stopLossMinCost) {
    // Mantém o lifecycle anterior em vez de rebaixar pra "testing" só por falta de dados
    // recentes na janela (ex.: daily_metrics ainda não sincronizado pro dia anterior).
    // Isso evita que campanhas em "Escalando" caiam pra "Testando" toda manhã.
    const keep: Lifecycle = (prevLifecycle as Lifecycle) || "testing";
    return { lifecycle: keep, action: "none", reason: `Dados insuficientes (lifecycle=${prevLifecycle}, janela=${windowDays}d, dias=${days}, custo acumulado=${round2(cost)} < min ${stopLossMinCost}) — mantendo status anterior`, roi, trend, delivery, avgDailySpend, window_days: windowDays, roi_today: todayRoi } as any;
  }

  const inCooldown = prev?.cooldown_until && new Date(prev.cooldown_until) > new Date();
  const cpaUpPct = Number(cfg.auto_cpa_up_pct) || 10;
  const cpaDownPct = Number(cfg.auto_cpa_down_pct) || 10;
  const lastCpa = prev?.last_cpa_action_date ? new Date(prev.last_cpa_action_date) : null;
  const daysSinceCpa = lastCpa ? Math.floor((Date.now() - lastCpa.getTime()) / 86400_000) : 999;
  const cpaCooldownOk = daysSinceCpa >= Number(cfg.auto_cpa_review_days);

  // E) Stop-loss: SÓ pausa se ROI acumulado cruza limite negativo, há dias suficientes,
  // tendência não é de melhora E o ROI de HOJE também não está positivo (proteção:
  // se hoje virou positivo, dá uma "segunda chance" — observa 3 dias antes de pausar).
  const todayProtect = todayRoi != null && todayRoi > 0;
  const SECOND_CHANCE_DAYS = 3;
  const prevSecondChance = prev?.second_chance_started_at ? new Date(prev.second_chance_started_at) : null;
  const daysInSecondChance = prevSecondChance
    ? Math.floor((Date.now() - prevSecondChance.getTime()) / 86400_000)
    : 0;

  // Se ROI acumulado já recuperou (>= 0), encerra a segunda chance e segue fluxo normal abaixo.
  const clearSecondChance = prevSecondChance && roi >= 0;

  if (roi <= stopLossRoi && days >= stopLossDays && trend !== "up") {
    // Já está em segunda chance: observa por 3 dias, depois decide.
    if (prevSecondChance) {
      if (daysInSecondChance < SECOND_CHANCE_DAYS) {
        return {
          lifecycle: "learning",
          action: "none",
          reason: `Segunda chance (${daysInSecondChance + 1}/${SECOND_CHANCE_DAYS}d): ROI ${round2(roi)}% (5d) · hoje ${todayRoi == null ? "?" : round2(todayRoi) + "%"} · observando antes de pausar`,
          roi, trend, delivery, avgDailySpend, roi_today: todayRoi, sub_threshold_days: 0,
          second_chance_started_at: prevSecondChance.toISOString(),
        } as any;
      }
      // Passou os 3 dias: avalia últimos 3 dias.
      const last3 = sliced.slice(-3);
      const cost3 = last3.reduce((s: number, d: any) => s + (Number(d.spend) || 0), 0);
      const grossRev3 = last3.reduce((s: number, d: any) => s + ((Number(d.spend) || 0) + (Number(d.profit) || 0)), 0);
      const net3 = grossRev3 * NET_FACTOR;
      const roi3 = cost3 > 0 ? ((net3 - cost3) / cost3) * 100 : 0;
      if (roi3 >= 0 || todayProtect) {
        // Recuperou — encerra segunda chance e mantém em learning, sem pausar.
        return {
          lifecycle: "learning",
          action: "none",
          reason: `Segunda chance bem-sucedida: ROI3d=${round2(roi3)}% · hoje ${todayRoi == null ? "?" : round2(todayRoi) + "%"} → mantendo (sai do stop-loss)`,
          roi, trend, delivery, avgDailySpend, roi_today: todayRoi, sub_threshold_days: 0,
          second_chance_started_at: null,
        } as any;
      }
      // Não recuperou: pausa.
      return {
        lifecycle: "bad", action: "pause",
        reason: `Segunda chance falhou (${daysInSecondChance}d): ROI3d=${round2(roi3)}% · ROI5d=${round2(roi)}% · hoje ${todayRoi == null ? "?" : round2(todayRoi) + "%"} → pausar`,
        roi, trend, delivery, avgDailySpend, roi_today: todayRoi, sub_threshold_days: 0,
        second_chance_started_at: null,
      } as any;
    }

    // Sem segunda chance ainda: se hoje virou positivo, abre a janela de 3d.
    if (todayProtect) {
      return {
        lifecycle: "learning",
        action: "none",
        reason: `Segunda chance iniciada: ROI ${round2(roi)}% (5d) negativo, mas hoje +${round2(todayRoi!)}% → observando 3d`,
        roi, trend, delivery, avgDailySpend, roi_today: todayRoi, sub_threshold_days: 0,
        second_chance_started_at: new Date().toISOString(),
      } as any;
    }

    // Sem segunda chance e hoje também ruim → pausa direto.
    return { lifecycle: "bad", action: "pause", reason: `ROI ${round2(roi)}% (${days}d) <= ${stopLossRoi}% · hoje ${todayRoi == null ? "?" : round2(todayRoi) + "%"} · trend ${trend} · delivery ${deliveryPct} → pausar`, roi, trend, delivery, avgDailySpend, roi_today: todayRoi, sub_threshold_days: 0 } as any;
  }

  // Fora da zona de stop-loss: a limpeza da segunda chance ocorre na persistência via `clearSecondChance`.

  // HISTERESE do "Escalando": se a campanha já estava Escalando, ela só sai
  // desse status depois de N dias seguidos com ROI abaixo do piso.
  // Isso evita o flip diário (Escalando → Aprendendo → Escalando) por oscilação.
  const SCALING_FLOOR = 15; // ROI mínimo pra manter Escalando
  const SCALING_GRACE_DAYS = 3; // dias seguidos abaixo do piso pra rebaixar
  const prevSubDays = Number(prev?.sub_threshold_days ?? 0);
  if (prevLifecycle === "scaling" && roi < Number(cfg.auto_scale_min_roi)) {
    if (roi >= SCALING_FLOOR) {
      return { lifecycle: "scaling", action: "none", reason: `ROI ${round2(roi)}% (≥${SCALING_FLOOR}%) — mantendo Escalando (oscilação dentro da janela)`, roi, trend, delivery, avgDailySpend, roi_today: todayRoi, sub_threshold_days: 0 } as any;
    }
    const nextSubDays = prevSubDays + 1;
    if (nextSubDays < SCALING_GRACE_DAYS) {
      return { lifecycle: "scaling", action: "none", reason: `ROI ${round2(roi)}% <${SCALING_FLOOR}% (${nextSubDays}/${SCALING_GRACE_DAYS}d) — observando antes de rebaixar de Escalando`, roi, trend, delivery, avgDailySpend, roi_today: todayRoi, sub_threshold_days: nextSubDays } as any;
    }
    // passou da janela de tolerância → segue para classificação natural (vai rebaixar)
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

// Auto-revert phase: walks every campaign on this (user, site, account) that
// was paused by the engine and is due for review (auto_pause_review_at <= now,
// state = pending_review). The first time a campaign comes due we attempt one
// resume; subsequent reviews after a re-pause skip the resume and mark the
// state 'exhausted_auto' so a human has to intervene. All outcomes write to
// automation_logs for the audit trail.
async function processPendingReviews(args: {
  admin: any;
  userId: string;
  siteId: string;
  accountId: string;
  dryRun: boolean;
  userJwt: string | null;
}): Promise<{ resumed: number; exhausted: number; failed: number; total: number }> {
  const { admin, userId, siteId, accountId, dryRun, userJwt } = args;

  const { data: pending } = await admin
    .from("campaign_automation")
    .select("id, campaign_id, auto_paused_at, auto_paused_reason, auto_pause_snapshot, auto_pause_resume_count")
    .eq("user_id", userId)
    .eq("site_id", siteId)
    .eq("google_account_id", accountId)
    .eq("auto_pause_state", "pending_review")
    .lte("auto_pause_review_at", new Date().toISOString());

  let resumed = 0, exhausted = 0, failed = 0;
  const total = pending?.length ?? 0;

  for (const row of (pending ?? []) as any[]) {
    const nowIso = new Date().toISOString();
    const resumeCount = Number(row.auto_pause_resume_count ?? 0);

    // Cap reached: don't auto-resume a second time. The campaign keeps the
    // paused state, but the auto-revert phase will stop touching it.
    if (resumeCount >= AUTO_PAUSE_MAX_RESUMES) {
      await admin.from("campaign_automation")
        .update({ auto_pause_state: "exhausted_auto" })
        .eq("id", row.id);
      await admin.from("automation_logs").insert({
        user_id: userId, site_id: siteId, google_account_id: accountId,
        campaign_id: row.campaign_id,
        action: "auto_pause_exhausted",
        reason: `Campanha já foi auto-retomada ${resumeCount}x e voltou a ser pausada. Limite de retomadas atingido — necessária intervenção humana.`,
        decision: "skipped",
        payload: { resume_count: resumeCount, paused_at: row.auto_paused_at, paused_reason: row.auto_paused_reason },
      });
      exhausted++;
      continue;
    }

    // Dry-run: log the intent but don't touch Google Ads.
    if (dryRun) {
      await admin.from("automation_logs").insert({
        user_id: userId, site_id: siteId, google_account_id: accountId,
        campaign_id: row.campaign_id,
        action: "auto_resume",
        reason: `Após ${AUTO_PAUSE_REVIEW_HOURS}h de pausa, retomaria a campanha pra uma nova avaliação.`,
        decision: "dry_run",
        payload: { paused_at: row.auto_paused_at, paused_reason: row.auto_paused_reason, snapshot: row.auto_pause_snapshot },
      });
      continue;
    }

    // Live: call google-ads-mutate to set the campaign back to ENABLED.
    try {
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (userJwt) {
        headers.Authorization = `Bearer ${userJwt}`;
      } else {
        headers.Authorization = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;
        headers["x-system-user-id"] = userId;
      }
      const res = await fetch(url, {
        method: "POST", headers,
        body: JSON.stringify({
          action: "set_status",
          status: "ENABLED",
          campaign_id: row.campaign_id,
          google_account_id: accountId,
          site_id: siteId,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        await admin.from("automation_logs").insert({
          user_id: userId, site_id: siteId, google_account_id: accountId,
          campaign_id: row.campaign_id,
          action: "auto_resume",
          reason: `Falha ao auto-retomar a campanha: ${j?.error || res.statusText}`,
          decision: "failed",
          error: j?.error || `mutate failed: ${res.status}`,
        });
        failed++;
        continue;
      }

      await admin.from("campaign_automation")
        .update({
          auto_pause_state: "auto_resumed",
          auto_pause_resumed_at: nowIso,
          auto_pause_resume_count: resumeCount + 1,
        })
        .eq("id", row.id);

      await admin.from("automation_logs").insert({
        user_id: userId, site_id: siteId, google_account_id: accountId,
        campaign_id: row.campaign_id,
        action: "auto_resume",
        reason: `Após ${AUTO_PAUSE_REVIEW_HOURS}h, campanha retomada automaticamente pra nova avaliação.`,
        decision: "executed",
        payload: {
          paused_at: row.auto_paused_at,
          paused_reason: row.auto_paused_reason,
          snapshot: row.auto_pause_snapshot,
          resume_count: resumeCount + 1,
        },
      });
      resumed++;
    } catch (e) {
      await admin.from("automation_logs").insert({
        user_id: userId, site_id: siteId, google_account_id: accountId,
        campaign_id: row.campaign_id,
        action: "auto_resume",
        reason: `Erro ao tentar auto-retomar: ${String(e instanceof Error ? e.message : e)}`,
        decision: "failed",
        error: String(e instanceof Error ? e.message : e),
      });
      failed++;
    }
  }

  return { resumed, exhausted, failed, total };
}

async function applyMutation(userJwt: string | null, userId: string, campaignId: string, accountId: string, siteId: string, decision: any, cfg: any, breaker: RunBreaker) {
  // Circuit breaker: gate pause mutations BEFORE we issue the fetch. If we've
  // already paused breaker.maxPauses campaigns in this run, or the breaker
  // tripped earlier, throw a typed error so the caller can log it cleanly.
  if (decision.action === "pause") {
    if (breaker.tripped || breaker.pausesApplied >= breaker.maxPauses) {
      breaker.tripped = true;
      breaker.trippedAt = breaker.trippedAt ?? new Date().toISOString();
      throw new CircuitBreakerTrippedError(breaker);
    }
  }

  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`;
  const body: any = { campaign_id: campaignId, google_account_id: accountId, site_id: siteId };
  if (decision.action === "pause") { body.action = "set_status"; body.status = "PAUSED"; }
  // resume is the safe reverse of pause; never gated by the circuit breaker.
  else if (decision.action === "resume") { body.action = "set_status"; body.status = "ENABLED"; }
  else if (decision.action === "scale") { body.action = "adjust_budget"; body.delta_pct = Number(decision._lightScalePct) || Number(cfg.auto_scale_budget_pct) || 20; }
  else if (decision.action === "cpa_up") { body.action = "adjust_cpa"; body.delta_pct = Number(decision._lightCpaPct) || Number(cfg.auto_cpa_up_pct) || 10; }
  else if (decision.action === "cpa_down") { body.action = "adjust_cpa"; body.delta_pct = -(Number(cfg.auto_cpa_down_pct) || 10); }
  else return;

  // Em chamadas do cron (sem userJwt) usamos o service role + header x-system-user-id
  // para que o google-ads-mutate identifique o dono da campanha sem JWT de usuário.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userJwt) {
    headers.Authorization = `Bearer ${userJwt}`;
  } else {
    headers.Authorization = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;
    headers["x-system-user-id"] = userId;
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.error) throw new Error(j?.error || `mutate failed: ${res.status}`);

  // Successful pause — count it against the breaker only after the API
  // confirmed the change. Failed mutations don't consume the budget.
  if (decision.action === "pause") breaker.pausesApplied++;
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

// ============================================================
// FLUXO WINNER (campanhas duplicadas pela expansão por país)
// ============================================================
// Estados:
//   winner_test     → 7 dias após ativação, sem mexer em nada (apenas observa)
//   winner_scaling  → ROI ≥ 0 e delivery > 70% → +20% no orçamento a cada 2d
//   winner_standby  → ROI < 0 ou queda forte → pausa escala, observa
//   winner_paused   → campanha foi pausada manualmente / por instabilidade
async function runWinnerCycle(args: {
  admin: any; userId: string; siteId: string; accountId: string;
  agg: any; meta: any; prevState: any; dailyBudget: number; dryRun: boolean; userJwt: string | null;
}): Promise<{ executed: boolean }> {
  const { admin, userId, siteId, accountId, agg, meta, prevState, dailyBudget, dryRun, userJwt } = args;
  const nowIso = new Date().toISOString();
  const fromStatus: Lifecycle = prevState?.lifecycle_status as Lifecycle;
  const status = String(meta?.status ?? "").toLowerCase();

  // 1) Marca início do teste de 7 dias quando o usuário ativa pela primeira vez.
  let winnerStartedAt: Date | null = prevState?.winner_started_at ? new Date(prevState.winner_started_at) : null;
  if (!winnerStartedAt && (status === "enabled" || status === "active")) {
    winnerStartedAt = new Date();
    await admin.from("campaign_automation").update({
      winner_started_at: winnerStartedAt.toISOString(),
      last_evaluated_at: nowIso,
    }).eq("user_id", userId).eq("campaign_id", agg.campaign_id);
  }

  // 2) Calcula métricas com janela específica do fluxo winner.
  const windowDays = fromStatus === "winner_scaling" ? WINNER_SCALE_INTERVAL_DAYS : (fromStatus === "winner_standby" ? 3 : WINNER_TEST_DAYS);
  const sortedAll = [...agg.daily].sort((a: any, b: any) => a.date.localeCompare(b.date));
  const sliced = sortedAll.slice(-windowDays);
  const cost = sliced.reduce((s: number, d: any) => s + (Number(d.spend) || 0), 0);
  const grossRevBrl = sliced.reduce((s: number, d: any) => s + ((Number(d.spend) || 0) + (Number(d.profit) || 0)), 0);
  const netRev = grossRevBrl * NET_FACTOR;
  const roi = cost > 0 ? ((netRev - cost) / cost) * 100 : 0;
  const days = new Set(sliced.map((d: any) => d.date)).size;
  const avgDailySpend = days > 0 ? cost / days : 0;
  const delivery = dailyBudget > 0 ? avgDailySpend / dailyBudget : null;
  const deliveryPct = delivery == null ? "?" : `${Math.round(delivery * 100)}%`;

  // Tendência (winner_scaling usa para parar escala em queda)
  const mid = Math.floor(sliced.length / 2);
  const avg = (arr: any[]) => arr.length ? arr.reduce((s, x) => s + x.roi, 0) / arr.length : 0;
  const r1 = avg(sliced.slice(0, mid));
  const r2 = avg(sliced.slice(mid));
  const diff = r2 - r1;
  const trend: "up" | "down" | "flat" = Math.abs(diff) < 5 ? "flat" : diff > 0 ? "up" : "down";

  let nextLifecycle: Lifecycle = fromStatus;
  let action: "none" | "pause" | "scale" = "none";
  let reason = "";

  // Campanha ainda PAUSED → fica em winner_test até o usuário ativar.
  if (status !== "enabled" && status !== "active") {
    nextLifecycle = "winner_paused";
    reason = "Aguardando ativação manual (winner)";
  } else if (!winnerStartedAt) {
    nextLifecycle = "winner_test";
    reason = "Aguardando registro de ativação";
  } else {
    const daysSinceStart = Math.floor((Date.now() - winnerStartedAt.getTime()) / 86400_000);
    if (daysSinceStart < WINNER_TEST_DAYS) {
      nextLifecycle = "winner_test";
      reason = `Fase de teste (${daysSinceStart}/${WINNER_TEST_DAYS}d) — sem alteração de orçamento`;
    } else if (roi < 0 || trend === "down" || (delivery != null && delivery < WINNER_DELIVERY_MIN)) {
      // ROI negativo, tendência de queda ou baixa entrega → standby (sem escalar)
      nextLifecycle = "winner_standby";
      reason = `ROI ${round2(roi)}% delivery ${deliveryPct} trend=${trend} → pausar escala (standby)`;
    } else {
      // ROI ≥ 0 + delivery > 70% + trend ok → escalar +20% se cooldown ok
      const lastScale = prevState?.last_scale_date ? new Date(prevState.last_scale_date) : null;
      const cdOk = !lastScale || (Date.now() - lastScale.getTime()) / 86400_000 >= WINNER_SCALE_INTERVAL_DAYS;
      if (cdOk) {
        nextLifecycle = "winner_scaling";
        action = "scale";
        reason = `ROI ${round2(roi)}% delivery ${deliveryPct} → +${WINNER_SCALE_PCT}% no orçamento (winner)`;
      } else {
        nextLifecycle = "winner_scaling";
        reason = `ROI ${round2(roi)}% delivery ${deliveryPct} — em cooldown de escala (${WINNER_SCALE_INTERVAL_DAYS}d)`;
      }
    }
  }

  let execStatus: "executed" | "dry_run" | "skipped" | "failed" = "skipped";
  let execError: string | null = null;
  if (action === "scale") {
    if (dryRun) {
      execStatus = "dry_run";
    } else {
      try {
        await applyMutation(userJwt, userId, agg.campaign_id, accountId, siteId, {
          action: "scale", _lightScalePct: WINNER_SCALE_PCT,
        }, { auto_scale_budget_pct: WINNER_SCALE_PCT });
        execStatus = "executed";
      } catch (e) { execStatus = "failed"; execError = String(e instanceof Error ? e.message : e); }
    }
  }

  const upd: any = {
    user_id: userId, site_id: siteId, campaign_id: agg.campaign_id, google_account_id: accountId,
    lifecycle_status: nextLifecycle,
    last_roi: round2(roi),
    roi_trend: trend,
    delivery_ratio: delivery == null ? null : round2(delivery),
    daily_budget: round2(dailyBudget),
    last_evaluated_at: nowIso,
  };
  if (winnerStartedAt) upd.winner_started_at = winnerStartedAt.toISOString();
  if (execStatus === "executed" && action === "scale") {
    upd.last_scale_date = nowIso;
    upd.last_action = "scale";
    upd.last_action_date = nowIso;
  }
  await admin.from("campaign_automation").upsert(upd, { onConflict: "user_id,site_id,google_account_id,campaign_id" });

  await admin.from("automation_logs").insert({
    user_id: userId,
    site_id: siteId,
    google_account_id: accountId,
    campaign_id: agg.campaign_id,
    action: action === "none" ? "classify" : action,
    reason,
    decision: execStatus,
    roi: round2(roi),
    cost: round2(cost),
    revenue: round2(netRev),
    lifecycle_from: fromStatus,
    lifecycle_to: nextLifecycle,
    error: execError,
    payload: { winner: true, days_since_start: winnerStartedAt ? Math.floor((Date.now() - winnerStartedAt.getTime()) / 86400_000) : null, delivery, trend },
  });

  return { executed: execStatus === "executed" };
}
