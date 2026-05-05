// Esteira manual "Reiniciar campanha"
// - actions: preview | init | tick | abort
// - preview: retorna ROI/custo/receita por dia dos últimos 7 dias (sem hoje)
// - init: registra campaign_restart_flow (active), aplica orçamento R$40/dia + Maximize Conversions (sem CPA), pausa orquestração padrão
// - tick: roda diariamente (cron) e avança/pausa cada fluxo ativo
// - abort: encerra o fluxo manualmente
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const NET_FACTOR = 0.935;

// Parâmetros do fluxo
const INITIAL_BUDGET_BRL = 40;
const PHASE1_DAYS = 4;
const PHASE1_MIN_ROI = -15;
const PHASE2_DAYS = 2;
const PHASE2_BUDGET_PCT = 10;
const PHASE3_LOOKBACK_DAYS = 8;
const PHASE4_DAYS = 3;
const PHASE4_DELIVERY_MIN = 0.7;
const PHASE4_CPA_REDUCTION_PCT = -10;

type FlowRow = {
  id: string;
  user_id: string;
  campaign_id: string;
  site_id: string | null;
  google_account_id: string | null;
  stage: string;
  status: string;
  start_date: string;
  initial_budget: number | null;
  current_budget: number | null;
  phase2_started_at: string | null;
  phase3_started_at: string | null;
  phase4_started_at: string | null;
  applied_cpa: number | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({} as any));
    const action = String(body?.action ?? "");

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Auth: cron usa service role + x-system-user-id; usuário usa Bearer JWT
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.replace("Bearer ", "");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    let userId: string | null = null;
    let userJwt: string | null = null;
    if (token === serviceRoleKey) {
      userId = req.headers.get("x-system-user-id");
    } else if (token) {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
      );
      const { data: claims } = await userClient.auth.getClaims(token);
      userId = claims?.claims?.sub ?? null;
      userJwt = token;
    }

    if (action === "tick") {
      const result = await tickAll(admin);
      return json({ ok: true, ...result });
    }

    if (!userId) return json({ error: "Login obrigatório" }, 401);

    if (action === "preview") {
      const campaignId = String(body?.campaign_id ?? "");
      if (!campaignId) return json({ error: "campaign_id obrigatório" }, 400);
      return json(await previewLast7Days(admin, userId, campaignId));
    }

    if (action === "init") {
      const campaignId = String(body?.campaign_id ?? "");
      if (!campaignId) return json({ error: "campaign_id obrigatório" }, 400);
      return json(await initFlow(admin, userId, userJwt, campaignId));
    }

    if (action === "abort") {
      const campaignId = String(body?.campaign_id ?? "");
      const note = String(body?.note ?? "Cancelado manualmente");
      const { error } = await admin
        .from("campaign_restart_flow")
        .update({ status: "paused", finished_at: new Date().toISOString(), notes: note, last_action: "abort" })
        .eq("user_id", userId)
        .eq("campaign_id", campaignId)
        .eq("status", "active");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "action inválida (preview | init | tick | abort)" }, 400);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

async function previewLast7Days(admin: any, userId: string, campaignId: string) {
  const today = new Date();
  const yest = new Date(today); yest.setUTCDate(today.getUTCDate() - 1);
  const from = new Date(today); from.setUTCDate(today.getUTCDate() - 7);
  const { data: rows } = await admin
    .from("daily_metrics")
    .select("date, spend, profit, conversions, clicks")
    .eq("user_id", userId)
    .eq("campaign_id", campaignId)
    .gte("date", isoDate(from))
    .lte("date", isoDate(yest))
    .order("date", { ascending: true });

  const daily = (rows ?? []).map((r: any) => {
    const spend = Number(r.spend) || 0;
    const profit = Number(r.profit) || 0;
    const grossRev = spend + profit;
    const netRev = grossRev * NET_FACTOR;
    const roi = spend > 0 ? ((netRev - spend) / spend) * 100 : 0;
    return {
      date: r.date,
      cost: round2(spend),
      revenue: round2(netRev),
      profit: round2(netRev - spend),
      roi: round2(roi),
      conversions: Number(r.conversions) || 0,
      clicks: Number(r.clicks) || 0,
    };
  });

  const totals = daily.reduce(
    (acc: any, d: any) => ({
      cost: acc.cost + d.cost,
      revenue: acc.revenue + d.revenue,
      conversions: acc.conversions + d.conversions,
    }),
    { cost: 0, revenue: 0, conversions: 0 },
  );
  const aggRoi = totals.cost > 0 ? ((totals.revenue - totals.cost) / totals.cost) * 100 : 0;

  // Existência de fluxo ativo
  const { data: active } = await admin
    .from("campaign_restart_flow")
    .select("id, stage, status, start_date")
    .eq("user_id", userId)
    .eq("campaign_id", campaignId)
    .eq("status", "active")
    .maybeSingle();

  return {
    daily,
    totals: { ...totals, roi: round2(aggRoi) },
    active_flow: active ?? null,
  };
}

async function initFlow(admin: any, userId: string, userJwt: string | null, campaignId: string) {
  // Bloqueia se já houver um fluxo ativo
  const { data: existing } = await admin
    .from("campaign_restart_flow")
    .select("id")
    .eq("user_id", userId)
    .eq("campaign_id", campaignId)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return { error: "Já existe um fluxo de reinício ativo para esta campanha" };

  // Resolve campanha + site + conta
  const { data: camp } = await admin
    .from("campaigns")
    .select("id, campaign_id, name, google_account_id")
    .eq("user_id", userId)
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (!camp) return { error: "Campanha não encontrada" };

  const siteId = await resolveCampaignSiteId(admin, userId, campaignId);

  // Aplica orçamento R$40/dia + bidding MAXIMIZE_CONVERSIONS (sem CPA)
  const apply = await applyInitialConfig(admin, userId, camp.google_account_id, campaignId, INITIAL_BUDGET_BRL);
  if (apply.error) return { error: `Falha ao aplicar config inicial: ${apply.error}` };
  const initialNotes = apply?.bidding?.strategy === "TARGET_CPA"
    ? `Orçamento inicial R$ ${INITIAL_BUDGET_BRL}/dia; Google manteve Target CPA por restrição da campanha`
    : `Orçamento inicial R$ ${INITIAL_BUDGET_BRL}/dia, Maximize Conversions (sem CPA)`;

  // Remove de qualquer esteira ativa: zera campaign_automation lifecycle p/ não interferir
  await admin
    .from("campaign_automation")
    .upsert({
      user_id: userId,
      campaign_id: campaignId,
      google_account_id: camp.google_account_id,
      site_id: siteId,
      lifecycle_status: "paused",
      last_action: "removed_for_restart",
      last_action_date: new Date().toISOString(),
    }, { onConflict: "user_id,site_id,google_account_id,campaign_id" });

  // Cria registro do fluxo
  const { data: inserted, error: insErr } = await admin
    .from("campaign_restart_flow")
    .insert({
      user_id: userId,
      campaign_id: campaignId,
      site_id: siteId,
      google_account_id: camp.google_account_id,
      stage: "restart_testing_day_0",
      status: "active",
      start_date: new Date().toISOString(),
      initial_budget: INITIAL_BUDGET_BRL,
      current_budget: INITIAL_BUDGET_BRL,
      last_action: "init",
      last_action_at: new Date().toISOString(),
      notes: initialNotes,
    })
    .select()
    .single();
  if (insErr) return { error: insErr.message };

  return { ok: true, flow: inserted, applied: apply };
}

async function tickAll(admin: any) {
  const today = new Date();
  const { data: flows } = await admin
    .from("campaign_restart_flow")
    .select("*")
    .eq("status", "active");

  const results: any[] = [];
  for (const f of (flows ?? []) as FlowRow[]) {
    try {
      const r = await tickFlow(admin, f, today);
      results.push({ campaign_id: f.campaign_id, stage_from: f.stage, ...r });
    } catch (e) {
      results.push({ campaign_id: f.campaign_id, error: String(e instanceof Error ? e.message : e) });
    }
  }
  return { count: flows?.length ?? 0, results };
}

async function tickFlow(admin: any, f: FlowRow, today: Date) {
  const start = new Date(f.start_date);
  const daysSinceStart = Math.floor((today.getTime() - start.getTime()) / 86400_000);

  // Janela: do start até ontem
  const yest = new Date(today); yest.setUTCDate(today.getUTCDate() - 1);
  const fromIso = isoDate(start);
  const toIso = isoDate(yest);

  const { data: dailyRows } = await admin
    .from("daily_metrics")
    .select("date, spend, profit, conversions")
    .eq("user_id", f.user_id)
    .eq("campaign_id", f.campaign_id)
    .gte("date", fromIso)
    .lte("date", toIso)
    .order("date", { ascending: true });

  const daily = (dailyRows ?? []).map((r: any) => {
    const spend = Number(r.spend) || 0;
    const profit = Number(r.profit) || 0;
    const grossRev = spend + profit;
    const netRev = grossRev * NET_FACTOR;
    return { date: r.date, spend, netRev, conversions: Number(r.conversions) || 0 };
  });

  const sumSpend = daily.reduce((s: number, d: any) => s + d.spend, 0);
  const sumRev = daily.reduce((s: number, d: any) => s + d.netRev, 0);
  const sumConv = daily.reduce((s: number, d: any) => s + d.conversions, 0);
  const totalRoi = sumSpend > 0 ? ((sumRev - sumSpend) / sumSpend) * 100 : 0;

  // Delivery (últimos N dias da fase atual): gasto/orçamento médio
  const dailyBudget = f.current_budget ?? f.initial_budget ?? INITIAL_BUDGET_BRL;
  const recentDays = daily.slice(-Math.max(2, PHASE2_DAYS));
  const avgRecentSpend = recentDays.length > 0 ? recentDays.reduce((s, d) => s + d.spend, 0) / recentDays.length : 0;
  const delivery = dailyBudget > 0 ? avgRecentSpend / dailyBudget : null;

  // Decisão por estágio
  let stage = f.stage;
  let action: "none" | "advance_phase2" | "advance_phase3" | "finalize_recovered" | "fail_pause" = "none";
  let reason = "";

  if (stage === "restart_testing_day_0" || stage === "restart_phase1_testing") {
    stage = "restart_phase1_testing";
    if (daysSinceStart >= PHASE1_DAYS) {
      if (totalRoi >= PHASE1_MIN_ROI) {
        action = "advance_phase2";
        reason = `ROI ${round2(totalRoi)}% ≥ ${PHASE1_MIN_ROI}% → +${PHASE2_BUDGET_PCT}% (fase 2)`;
      } else {
        action = "fail_pause";
        reason = `Falha na recuperação: ROI ${round2(totalRoi)}% < ${PHASE1_MIN_ROI}% após ${PHASE1_DAYS}d`;
      }
    } else {
      reason = `Fase 1 — testando (${daysSinceStart}/${PHASE1_DAYS}d), ROI ${round2(totalRoi)}%`;
    }
  } else if (stage === "restart_phase2_micro_scale") {
    const p2 = f.phase2_started_at ? new Date(f.phase2_started_at) : start;
    const daysInP2 = Math.floor((today.getTime() - p2.getTime()) / 86400_000);
    if (daysInP2 >= PHASE2_DAYS) {
      if (totalRoi >= 0) {
        action = "advance_phase3";
        reason = `ROI total ${round2(totalRoi)}% ≥ 0 após ${daysSinceStart}d → aplicar CPA médio (fase 3)`;
      } else {
        action = "fail_pause";
        reason = `Falha pós micro-escala: ROI ${round2(totalRoi)}% < 0`;
      }
    } else {
      reason = `Fase 2 — micro escala (${daysInP2}/${PHASE2_DAYS}d), ROI ${round2(totalRoi)}%`;
    }
  } else if (stage === "restart_phase3_cpa_applied" || stage === "restart_phase4_optimization") {
    stage = "restart_phase4_optimization";
    const p4 = f.phase4_started_at ? new Date(f.phase4_started_at) : (f.phase3_started_at ? new Date(f.phase3_started_at) : start);
    const daysInP4 = Math.floor((today.getTime() - p4.getTime()) / 86400_000);
    if (daysInP4 >= PHASE4_DAYS) {
      const okDelivery = delivery == null ? false : delivery >= PHASE4_DELIVERY_MIN;
      if (totalRoi >= 0 && okDelivery) {
        action = "finalize_recovered";
        reason = `ROI ${round2(totalRoi)}% ≥ 0 e delivery ${Math.round((delivery ?? 0) * 100)}% → reduzir CPA ${PHASE4_CPA_REDUCTION_PCT}% e marcar como RECUPERADA`;
      } else {
        action = "fail_pause";
        reason = `Falha fase 4: ROI ${round2(totalRoi)}% delivery ${delivery == null ? "?" : Math.round(delivery * 100) + "%"}`;
      }
    } else {
      reason = `Fase 4 — otimização (${daysInP4}/${PHASE4_DAYS}d), ROI ${round2(totalRoi)}%`;
    }
  }

  // Executa ação
  let executed = false;
  const upd: any = {
    roi: round2(totalRoi),
    delivery_ratio: delivery == null ? null : round2(delivery),
    stage,
    last_action: action,
    last_action_at: new Date().toISOString(),
  };

  if (action === "advance_phase2") {
    const r = await mutateBudgetDelta(admin, f.user_id, f.google_account_id!, f.campaign_id, PHASE2_BUDGET_PCT);
    if (r.error) {
      reason = `Falha ao escalar +${PHASE2_BUDGET_PCT}%: ${r.error}`;
    } else {
      upd.stage = "restart_phase2_micro_scale";
      upd.phase2_started_at = new Date().toISOString();
      upd.current_budget = r.budget_to ?? upd.current_budget;
      executed = true;
    }
  } else if (action === "advance_phase3") {
    const avgCpa = sumConv > 0 ? sumSpend / sumConv : null;
    if (!avgCpa || avgCpa <= 0) {
      reason = `Não foi possível calcular CPA (conversões=${sumConv}) — pausando fluxo`;
      action = "fail_pause";
    } else {
      const r = await applyTargetCpa(admin, f.user_id, f.google_account_id!, f.campaign_id, avgCpa);
      if (r.error) {
        reason = `Falha ao aplicar CPA ${avgCpa.toFixed(2)}: ${r.error}`;
      } else {
        upd.stage = "restart_phase3_cpa_applied";
        upd.phase3_started_at = new Date().toISOString();
        upd.phase4_started_at = new Date().toISOString();
        upd.avg_cpa = round2(avgCpa);
        upd.applied_cpa = round2(avgCpa);
        executed = true;
        // Avança imediatamente para fase 4 (monitoramento)
        upd.stage = "restart_phase4_optimization";
      }
    }
  } else if (action === "finalize_recovered") {
    const newCpa = (f.applied_cpa ?? 0) * (1 + PHASE4_CPA_REDUCTION_PCT / 100);
    if (newCpa > 0) {
      await applyTargetCpa(admin, f.user_id, f.google_account_id!, f.campaign_id, newCpa);
      upd.applied_cpa = round2(newCpa);
    }
    upd.status = "recovered";
    upd.stage = "restart_recovered";
    upd.finished_at = new Date().toISOString();
    executed = true;
  }

  if (action === "fail_pause") {
    await mutateSetStatus(admin, f.user_id, f.google_account_id!, f.campaign_id, "PAUSED");
    upd.status = "failed";
    upd.stage = "restart_failed";
    upd.finished_at = new Date().toISOString();
    executed = true;
  }

  upd.notes = reason;
  await admin.from("campaign_restart_flow").update(upd).eq("id", f.id);

  // Log estruturado
  await admin.from("automation_logs").insert({
    user_id: f.user_id,
    site_id: f.site_id,
    google_account_id: f.google_account_id,
    campaign_id: f.campaign_id,
    action: `restart_${action}`,
    decision: executed ? "executed" : "skipped",
    reason,
    roi: round2(totalRoi),
    cost: round2(sumSpend),
    revenue: round2(sumRev),
    lifecycle_from: f.stage,
    lifecycle_to: upd.stage ?? f.stage,
    payload: { restart_flow_id: f.id, days_since_start: daysSinceStart, delivery, conversions: sumConv },
  });

  return { stage_to: upd.stage ?? f.stage, action, executed, roi: round2(totalRoi), reason };
}

// =============== Helpers Google Ads (chamam google-ads-mutate internamente) ===============

async function mutateBudgetDelta(admin: any, userId: string, accountId: string, campaignId: string, deltaPct: number) {
  return await invokeMutate(admin, userId, { action: "adjust_budget", campaign_id: campaignId, google_account_id: accountId, delta_pct: deltaPct });
}

async function mutateSetStatus(admin: any, userId: string, accountId: string, campaignId: string, status: "PAUSED" | "ENABLED") {
  return await invokeMutate(admin, userId, { action: "set_status", campaign_id: campaignId, google_account_id: accountId, status });
}

async function invokeMutate(_admin: any, userId: string, body: any) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    "x-system-user-id": userId,
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.error) return { error: j?.error || `mutate failed: ${res.status}` };
  return j;
}

// Aplica orçamento absoluto (R$/dia) + Maximize Conversions (sem CPA) direto na API GAds.
async function applyInitialConfig(admin: any, userId: string, accountId: string, campaignId: string, budgetBrl: number) {
  const ctx = await loadGAdsContext(admin, accountId);
  if (ctx.error) return { error: ctx.error };

  // 1) Detecta payment_mode + budget_type da campanha
  const queryB = `SELECT campaign.id, campaign.payment_mode, campaign.bidding_strategy_type,
                         campaign.maximize_conversions.target_cpa_micros,
                         campaign.target_cpa.target_cpa_micros,
                         campaign.campaign_budget, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.type
                  FROM campaign WHERE campaign.id = ${campaignId}`;
  const sRes = await fetch(`${ctx.apiBase}/googleAds:search`, { method: "POST", headers: ctx.headers, body: JSON.stringify({ query: queryB }) });
  const sJson = await sRes.json();
  if (!sRes.ok) return { error: `budget search: ${JSON.stringify(sJson).slice(0, 200)}` };
  const row = (sJson.results ?? [])[0];
  const budgetId = row?.campaignBudget?.id;
  if (!budgetId) return { error: "Campanha sem orçamento" };
  const currentStrat = row?.campaign?.biddingStrategyType ?? "";

  // 2) ajusta orçamento absoluto
  const nextMicros = Math.round(budgetBrl * 1_000_000);
  const bRes = await fetch(`${ctx.apiBase}/campaignBudgets:mutate`, {
    method: "POST", headers: ctx.headers,
    body: JSON.stringify({
      operations: [{
        update: {
          resourceName: `customers/${ctx.customerId}/campaignBudgets/${budgetId}`,
          amountMicros: String(nextMicros),
        },
        updateMask: "amount_micros",
      }],
    }),
  });
  const bJson = await bRes.json();
  if (!bRes.ok) return { error: `budget mutate: ${JSON.stringify(bJson).slice(0, 200)}` };
  await admin.from("campaigns").update({ budget_micros: nextMicros }).eq("user_id", userId).eq("campaign_id", campaignId);

  // 3) Estratégia — tenta remover CPA/portfolio sem travar o reinício quando o Google bloqueia a troca.
  const bidding = await applyRestartBidding(ctx, campaignId, currentStrat);
  if (bidding.error) return { error: bidding.error };

  return { ok: true, budget_brl: budgetBrl, bidding };
}

async function applyRestartBidding(ctx: any, campaignId: string, currentStrat: string) {
  const baseRN = `customers/${ctx.customerId}/campaigns/${campaignId}`;
  const errors: string[] = [];
  const mutate = async (label: string, update: any, mask: string) => {
    const r = await fetch(`${ctx.apiBase}/campaigns:mutate`, {
      method: "POST", headers: ctx.headers,
      body: JSON.stringify({ operations: [{ update, updateMask: mask }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, label, json: j };
    errors.push(`[${label}] ${googleAdsError(j)}`);
    return { ok: false, label, json: j };
  };

  // Target CPA moderno costuma aparecer como MAXIMIZE_CONVERSIONS com target_cpa_micros.
  if (currentStrat === "MAXIMIZE_CONVERSIONS" || currentStrat === "TARGET_CPA") {
    const clearTarget = await mutate("clear-target-cpa", { resourceName: baseRN, maximizeConversions: {} }, "maximize_conversions.target_cpa_micros");
    if (clearTarget.ok) return { ok: true, strategy: "MAXIMIZE_CONVERSIONS", variant: clearTarget.label };
  }

  const direct = await mutate("direct-maximize-conversions", { resourceName: baseRN, maximizeConversions: {} }, "maximize_conversions");
  if (direct.ok) return { ok: true, strategy: "MAXIMIZE_CONVERSIONS", variant: direct.label };

  // Portfolio: primeiro solta o bidding_strategy compartilhado, depois tenta aplicar a estratégia standard.
  const clearPortfolio = await mutate("clear-portfolio", { resourceName: baseRN }, "bidding_strategy");
  if (clearPortfolio.ok) {
    const afterClear = await mutate("set-maximize-after-clear", { resourceName: baseRN, maximizeConversions: {} }, "maximize_conversions");
    if (afterClear.ok) return { ok: true, strategy: "MAXIMIZE_CONVERSIONS", variant: afterClear.label };

    const clearTargetAfter = await mutate("clear-target-after-portfolio", { resourceName: baseRN, maximizeConversions: {} }, "maximize_conversions.target_cpa_micros");
    if (clearTargetAfter.ok) return { ok: true, strategy: "MAXIMIZE_CONVERSIONS", variant: clearTargetAfter.label };
  }

  // Se for Target CPA e o Google não aceitar a troca, não bloqueia o reinício: orçamento/remoção da automação continuam.
  if (currentStrat === "TARGET_CPA") {
    return { ok: true, strategy: "TARGET_CPA", variant: "kept-google-blocked-switch", warning: errors.join(" || ").slice(0, 1200) };
  }

  return { error: `bidding switch (atual: ${currentStrat}): ${errors.join(" || ").slice(0, 1500)}` };
}

// Aplica TARGET_CPA na campanha (via maximize_conversions com targetCpaMicros)
async function applyTargetCpa(admin: any, _userId: string, accountId: string, campaignId: string, cpaBrl: number) {
  const ctx = await loadGAdsContext(admin, accountId);
  if (ctx.error) return { error: ctx.error };
  const targetMicros = Math.max(10_000, Math.round(cpaBrl * 1_000_000 / 10_000) * 10_000);
  const r = await fetch(`${ctx.apiBase}/campaigns:mutate`, {
    method: "POST", headers: ctx.headers,
    body: JSON.stringify({
      operations: [{
        update: {
          resourceName: `customers/${ctx.customerId}/campaigns/${campaignId}`,
          maximizeConversions: { targetCpaMicros: String(targetMicros) },
        },
        updateMask: "maximize_conversions.target_cpa_micros",
      }],
    }),
  });
  const j = await r.json();
  if (!r.ok) return { error: `cpa mutate: ${JSON.stringify(j).slice(0, 200)}` };
  return { ok: true, target_cpa_brl: targetMicros / 1_000_000 };
}

async function loadGAdsContext(admin: any, accountId: string): Promise<{ customerId?: string; apiBase?: string; headers?: Record<string, string>; error?: string }> {
  const { data: acc } = await admin.from("google_accounts")
    .select("customer_id, login_customer_id, refresh_token")
    .eq("id", accountId).maybeSingle();
  if (!acc?.refresh_token || !acc?.customer_id) return { error: "Conta sem refresh token" };
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: acc.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokJson = await tokRes.json();
  if (!tokRes.ok) return { error: `token: ${JSON.stringify(tokJson).slice(0, 200)}` };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokJson.access_token}`,
    "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
    "Content-Type": "application/json",
  };
  if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;
  return { customerId: acc.customer_id, apiBase: `https://googleads.googleapis.com/v21/customers/${acc.customer_id}`, headers };
}

async function resolveCampaignSiteId(admin: any, userId: string, campaignId: string): Promise<string | null> {
  const { data } = await admin.from("gam_placement_revenue")
    .select("site_id, revenue_usd")
    .eq("user_id", userId).eq("campaign_id", campaignId).not("site_id", "is", null).limit(500);
  const bySite = new Map<string, number>();
  for (const r of data ?? []) {
    const sid = String(r.site_id ?? "");
    if (!sid) continue;
    bySite.set(sid, (bySite.get(sid) ?? 0) + (Number(r.revenue_usd) || 0));
  }
  if (bySite.size === 0) return null;
  return [...bySite.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function googleAdsError(j: any) {
  const detail = j?.error?.details?.[0]?.errors?.[0];
  const code = detail?.errorCode ? JSON.stringify(detail.errorCode) : j?.error?.status;
  const msg = detail?.message ?? j?.error?.message ?? JSON.stringify(j);
  const field = detail?.location?.fieldPathElements?.map((p: any) => p.fieldName).filter(Boolean).join(".");
  return `${code ? code + ": " : ""}${msg}${field ? ` (${field})` : ""}`.slice(0, 300);
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function round2(n: number) { return Math.round((Number(n) || 0) * 100) / 100; }
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
