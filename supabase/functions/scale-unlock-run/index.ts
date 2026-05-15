// Engine "Destravar Escala" (Scale Unlock) — TOTALMENTE separada das outras automações.
// Foco: aumentar entrega/spend de campanhas Google Ads que estão travadas mas com sinais bons.
// Não toca em: placements, geo, funil, automação principal, winners, restart-flow.
// Apenas sinaliza scale_unlock_locked_until em campaign_automation/campaign_funnel
// para que as outras engines IGNorem campanhas durante a janela de observação.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

type Json = Record<string, unknown>;

interface SUConfig {
  user_id: string;
  enabled: boolean;
  dry_run: boolean;
  min_roi_pct: number;
  max_delivery_rate: number;
  min_ctr_pct: number;
  min_spend_brl: number;
  min_conversions: number;
  lookback_days: number;
  scale_pct: number;
  reduce_budget_pct: number;
  relax_cpa_pct: number;
  scale_min_roi_pct: number;
  scale_min_delivery: number;
  observation_hours: number;
  cooldown_hours: number;
  scale_interval_hours: number;
  fail_after_days: number;
  fail_max_roi: number;
}

interface CampAgg {
  campaign_id: string;
  google_account_id: string | null;
  spend: number;
  revenue: number; // already net for ROI calc
  profit: number;
  clicks: number;
  impressions: number;
  conversions: number;
  days: number;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({} as Json));
    const dryRunOverride = (body as any)?.dry_run as boolean | undefined;
    const targetUserId = (body as any)?.user_id as string | undefined;
    const siteIds = Array.isArray((body as any)?.site_ids) ? ((body as any).site_ids as string[]).map(String) : null;
    const cronRunAll = Boolean((body as any)?.cron_run_all);

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    const systemMode = token === SERVICE_KEY || cronRunAll;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Modo sistema sem user_id → loop em TODOS usuários com engine habilitada (cron)
    if ((systemMode && !targetUserId) || cronRunAll) {
      const { data: enabledCfgs } = await admin
        .from("scale_unlock_config")
        .select("*")
        .eq("enabled", true);
      const results: any[] = [];
      for (const cfgRow of enabledCfgs ?? []) {
        const cfg = cfgRow as unknown as SUConfig;
        const dryRun = dryRunOverride ?? cfg.dry_run;
        try {
          const r = await runForUser(admin, cfg.user_id, cfg, dryRun, SERVICE_KEY, siteIds);
          await admin.from("scale_unlock_config")
            .update({ last_run_at: new Date().toISOString() })
            .eq("user_id", cfg.user_id);
          results.push({ user_id: cfg.user_id, ...r });
        } catch (err) {
          results.push({ user_id: cfg.user_id, error: String((err as Error)?.message ?? err) });
        }
      }
      return json({ ok: true, mode: "cron_all_users", users: results.length, results });
    }

    let userId = targetUserId ?? "";
    if (!systemMode) {
      const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: claims } = await userClient.auth.getClaims(token);
      userId = String(claims?.claims?.sub ?? "");
      if (!userId) return json({ error: "Token inválido" }, 401);
    }

    // Carrega ou cria config
    let { data: cfgRow } = await admin
      .from("scale_unlock_config")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (!cfgRow) {
      const { data: created } = await admin
        .from("scale_unlock_config")
        .insert({ user_id: userId })
        .select("*")
        .single();
      cfgRow = created;
    }
    const cfg = cfgRow as unknown as SUConfig;
    if (!cfg.enabled && !systemMode) {
      return json({ ok: true, skipped: "engine_disabled" });
    }
    const dryRun = dryRunOverride ?? cfg.dry_run;

    const result = await runForUser(admin, userId, cfg, dryRun, token, siteIds);

    await admin
      .from("scale_unlock_config")
      .update({ last_run_at: new Date().toISOString() })
      .eq("user_id", userId);

    return json({ ok: true, dry_run: dryRun, ...result });
  } catch (e) {
    console.error("[scale-unlock-run] fatal", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function runForUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
  cfg: SUConfig,
  dryRun: boolean,
  jwt: string,
  siteIds: string[] | null,
) {
  const lookback = Math.max(2, Math.min(14, cfg.lookback_days));
  const sinceISO = new Date(Date.now() - lookback * 86400_000).toISOString().slice(0, 10);

  // Se filtrou por sites, buscar contas Google Ads vinculadas
  let allowedAccountIds: Set<string> | null = null;
  if (siteIds && siteIds.length > 0) {
    const { data: linksFilter } = await admin
      .from("account_site_links")
      .select("google_account_id, site_id")
      .eq("user_id", userId)
      .in("site_id", siteIds);
    allowedAccountIds = new Set((linksFilter ?? []).map((l: any) => String(l.google_account_id)));
    if (allowedAccountIds.size === 0) {
      return { campaigns_evaluated: 0, actions: 0, sites: siteIds.length, accounts: 0 };
    }
  }

  // Campanhas Google Ads ativas com budget
  let campQuery = admin
    .from("campaigns")
    .select("campaign_id, name, status, google_account_id, budget_micros, target_cpa_micros")
    .eq("user_id", userId)
    .in("status", ["enabled", "active"])
    .not("budget_micros", "is", null);
  if (allowedAccountIds) campQuery = campQuery.in("google_account_id", Array.from(allowedAccountIds));
  const { data: campaigns } = await campQuery;

  if (!campaigns || campaigns.length === 0) {
    return { campaigns_evaluated: 0, actions: 0 };
  }

  // Métricas dos últimos N dias
  const campaignIds = campaigns.map((c: any) => String(c.campaign_id));
  const { data: metrics } = await admin
    .from("daily_metrics")
    .select("campaign_id, google_account_id, date, spend, clicks, impressions, conversions, revenue, profit")
    .eq("user_id", userId)
    .in("campaign_id", campaignIds)
    .gte("date", sinceISO);

  const aggMap = new Map<string, CampAgg>();
  const dayMap = new Map<string, Set<string>>();
  for (const m of metrics ?? []) {
    const cid = String((m as any).campaign_id);
    let a = aggMap.get(cid);
    if (!a) {
      a = { campaign_id: cid, google_account_id: (m as any).google_account_id ?? null,
            spend: 0, revenue: 0, profit: 0, clicks: 0, impressions: 0, conversions: 0, days: 0 };
      aggMap.set(cid, a);
    }
    a.spend += Number((m as any).spend) || 0;
    a.revenue += Number((m as any).revenue) || 0;
    a.profit += Number((m as any).profit) || 0;
    a.clicks += Number((m as any).clicks) || 0;
    a.impressions += Number((m as any).impressions) || 0;
    a.conversions += Number((m as any).conversions) || 0;
    if (!dayMap.has(cid)) dayMap.set(cid, new Set());
    dayMap.get(cid)!.add(String((m as any).date));
  }
  for (const [cid, a] of aggMap) a.days = dayMap.get(cid)?.size ?? 0;

  // Estado prévio
  const { data: states } = await admin
    .from("scale_unlock_state")
    .select("*")
    .eq("user_id", userId);
  const stateByCamp = new Map<string, any>();
  for (const s of states ?? []) stateByCamp.set(String((s as any).campaign_id), s);

  // Mapa account → site (primeiro link encontrado; melhor que nada)
  const { data: links } = await admin
    .from("account_site_links")
    .select("google_account_id, site_id")
    .eq("user_id", userId);
  const siteByAccount = new Map<string, string>();
  for (const l of links ?? []) {
    const k = String((l as any).google_account_id);
    if (!siteByAccount.has(k)) siteByAccount.set(k, String((l as any).site_id));
  }

  let evaluated = 0, actions = 0;
  const nowMs = Date.now();

  for (const camp of campaigns) {
    evaluated++;
    const cid = String((camp as any).campaign_id);
    const accountId = (camp as any).google_account_id as string | null;
    const siteId = accountId ? (siteByAccount.get(accountId) ?? null) : null;
    const agg = aggMap.get(cid);
    const state = stateByCamp.get(cid);

    // dados insuficientes
    if (!agg || agg.days < 2 || agg.spend <= 0) continue;

    // Em observação ou cooldown? Apenas atualiza métricas e segue
    if (state?.observe_until && new Date(state.observe_until).getTime() > nowMs) continue;
    if (state?.cooldown_until && new Date(state.cooldown_until).getTime() > nowMs) continue;

    // Falha definitiva: não mexe mais
    if (state?.status === "unlock_failed") continue;

    const dailyBudget = Number((camp as any).budget_micros) / 1_000_000;
    const targetCpa = (camp as any).target_cpa_micros
      ? Number((camp as any).target_cpa_micros) / 1_000_000 : null;
    const expectedSpend = dailyBudget * agg.days;
    const deliveryRate = expectedSpend > 0 ? agg.spend / expectedSpend : 0;
    const roi = agg.spend > 0 ? (agg.profit / agg.spend) * 100 : 0;
    const ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : 0;
    const cpa = agg.conversions > 0 ? agg.spend / agg.conversions : null;

    const score = computeUnlockScore({
      roi, deliveryRate, ctr, conversions: agg.conversions, spend: agg.spend, cfg,
    });
    const confidence = computeConfidence({ roi, deliveryRate, ctr, days: agg.days });

    const decision = decideAction({ camp, agg, state, cfg, dailyBudget, deliveryRate, roi, ctr, targetCpa });

    // upsert estado base mesmo quando não age
    const baseStateUpdate: Json = {
      user_id: userId,
      campaign_id: cid,
      campaign_name: (camp as any).name ?? null,
      google_account_id: accountId,
      site_id: siteId,
      unlock_score: score,
      unlock_confidence: confidence,
      last_roi_pct: roi,
      last_delivery_rate: deliveryRate,
      last_ctr_pct: ctr,
      current_budget: dailyBudget,
      current_cpa: targetCpa,
      base_budget: state?.base_budget ?? dailyBudget,
      base_cpa: state?.base_cpa ?? targetCpa,
      updated_at: new Date().toISOString(),
    };

    if (!decision || decision.action === "noop") {
      if (!state) {
        baseStateUpdate.status = score >= 60 ? "candidate" : "idle";
        baseStateUpdate.started_at = new Date().toISOString();
      }
      await admin.from("scale_unlock_state").upsert(baseStateUpdate, { onConflict: "user_id,campaign_id" });
      continue;
    }

    // Executa ação (ou simula em dry-run)
    let executedOk = false; let errorMsg: string | null = null;
    if (!dryRun) {
      try {
        await applyAction(jwt, cid, accountId, siteId, decision);
        executedOk = true;
      } catch (e) {
        errorMsg = String((e as Error)?.message ?? e);
        executedOk = false;
      }
    } else {
      executedOk = true;
    }

    // Log
    await admin.from("scale_unlock_logs").insert({
      user_id: userId,
      campaign_id: cid,
      campaign_name: (camp as any).name,
      google_account_id: accountId,
      site_id: siteId,
      action: decision.action,
      reason: decision.reason,
      status: dryRun ? "dry_run" : (executedOk ? "executed" : "failed"),
      error: errorMsg,
      old_budget: dailyBudget,
      new_budget: decision.newBudget ?? null,
      old_cpa: targetCpa,
      new_cpa: decision.newCpa ?? null,
      roi_before: roi,
      delivery_before: deliveryRate,
      unlock_score: score,
      unlock_confidence: confidence,
      payload: { decision, agg },
    });

    if (executedOk) actions++;

    // Atualiza estado + locks
    const observeUntil = new Date(nowMs + cfg.observation_hours * 3600_000).toISOString();
    const cooldownUntil = new Date(nowMs + cfg.cooldown_hours * 3600_000).toISOString();

    Object.assign(baseStateUpdate, {
      status: decision.nextStatus,
      last_action: decision.action,
      last_action_at: new Date().toISOString(),
      observe_until: observeUntil,
      cooldown_until: cooldownUntil,
      attempts: (state?.attempts ?? 0) + 1,
      current_budget: decision.newBudget ?? dailyBudget,
      current_cpa: decision.newCpa ?? targetCpa,
      started_at: state?.started_at ?? new Date().toISOString(),
      ...(decision.nextStatus === "unlock_failed"
        ? { failed_at: new Date().toISOString(), failed_reason: decision.reason }
        : {}),
      ...(decision.nextStatus === "unlock_succeeded"
        ? { succeeded_at: new Date().toISOString() } : {}),
    });
    await admin.from("scale_unlock_state").upsert(baseStateUpdate, { onConflict: "user_id,campaign_id" });

    // Lock: outras engines não devem mexer durante a observação
    await admin.from("campaign_automation")
      .update({ scale_unlock_locked_until: observeUntil })
      .eq("user_id", userId).eq("campaign_id", cid);
    await admin.from("campaign_funnel")
      .update({ scale_unlock_locked_until: observeUntil })
      .eq("user_id", userId).eq("campaign_id", cid);
  }

  return { campaigns_evaluated: evaluated, actions };
}

// ===== Score & Decisão =====

function computeUnlockScore(p: {
  roi: number; deliveryRate: number; ctr: number;
  conversions: number; spend: number; cfg: SUConfig;
}): number {
  const { cfg } = p;
  let s = 0;
  // ROI bom (acima do mínimo) puxa pra cima
  if (p.roi >= cfg.min_roi_pct) s += Math.min(30, 30 * ((p.roi - cfg.min_roi_pct) / 30 + 1));
  // Delivery baixa = travada (oportunidade)
  if (p.deliveryRate < cfg.max_delivery_rate) s += 30 * (1 - p.deliveryRate / cfg.max_delivery_rate);
  // CTR saudável
  if (p.ctr >= cfg.min_ctr_pct) s += 15;
  // Conversões existem
  if (p.conversions >= cfg.min_conversions) s += 15;
  // Spend mínimo
  if (p.spend >= cfg.min_spend_brl) s += 10;
  return Math.round(Math.max(0, Math.min(100, s)));
}

function computeConfidence(p: { roi: number; deliveryRate: number; ctr: number; days: number }): number {
  let c = 0;
  if (p.days >= 5) c += 30; else c += 6 * p.days;
  if (p.roi > 0) c += 25;
  if (p.ctr >= 1) c += 20;
  if (p.deliveryRate > 0.1) c += 25;
  return Math.round(Math.max(0, Math.min(100, c)));
}

interface Decision {
  action: "reduce_budget" | "increase_budget" | "relax_cpa" | "mark_failed" | "mark_succeeded" | "noop";
  reason: string;
  nextStatus: string;
  newBudget?: number;
  newCpa?: number;
}

function decideAction(p: {
  camp: any; agg: CampAgg; state: any; cfg: SUConfig;
  dailyBudget: number; deliveryRate: number; roi: number; ctr: number; targetCpa: number | null;
}): Decision | null {
  const { agg, state, cfg, dailyBudget, deliveryRate, roi, ctr, targetCpa } = p;
  const startedAt = state?.started_at ? new Date(state.started_at).getTime() : Date.now();
  const elapsedDays = (Date.now() - startedAt) / 86400_000;

  // FALHA: muito tempo tentando, ROI ruim
  if (state && elapsedDays >= cfg.fail_after_days && roi < cfg.fail_max_roi) {
    return { action: "mark_failed", reason: `Sem destravar em ${elapsedDays.toFixed(1)}d (ROI ${roi.toFixed(1)}%)`,
             nextStatus: "unlock_failed" };
  }

  // SUCESSO/ESCALA: delivery alta + ROI alto → +scale_pct% budget
  if (deliveryRate >= cfg.scale_min_delivery && roi >= cfg.scale_min_roi_pct) {
    const newBudget = round2(dailyBudget * (1 + cfg.scale_pct / 100));
    return {
      action: "increase_budget",
      reason: `Escala: delivery ${(deliveryRate * 100).toFixed(0)}% + ROI ${roi.toFixed(1)}%`,
      nextStatus: "scaling",
      newBudget,
    };
  }

  // Critérios mínimos pra considerar travada
  const isCandidate =
    deliveryRate < cfg.max_delivery_rate &&
    roi >= cfg.min_roi_pct &&
    ctr >= cfg.min_ctr_pct &&
    agg.conversions >= cfg.min_conversions &&
    agg.spend >= cfg.min_spend_brl;

  if (!isCandidate) return { action: "noop", reason: "Não atende critérios de travamento", nextStatus: state?.status ?? "idle" };

  const lastAction = state?.last_action as string | undefined;

  // Já tentou reduzir budget e ainda travada → relaxa CPA (se tiver target_cpa)
  if (lastAction === "reduce_budget" && targetCpa && targetCpa > 0) {
    const newCpa = round2(targetCpa * (1 + cfg.relax_cpa_pct / 100));
    return {
      action: "relax_cpa",
      reason: `Após reduzir budget, delivery ${(deliveryRate * 100).toFixed(0)}% — relaxa CPA +${cfg.relax_cpa_pct}%`,
      nextStatus: "cpa_relaxed",
      newCpa,
    };
  }

  // Primeira tentativa: reduz budget para forçar entrega melhor
  const newBudget = Math.max(10, round2(dailyBudget * (cfg.reduce_budget_pct / 100)));
  if (Math.abs(newBudget - dailyBudget) < 1) {
    return { action: "noop", reason: "Mudança de budget muito pequena", nextStatus: state?.status ?? "idle" };
  }
  return {
    action: "reduce_budget",
    reason: `Travada: delivery ${(deliveryRate * 100).toFixed(0)}% / ROI ${roi.toFixed(1)}% — reduz budget para ${cfg.reduce_budget_pct}% do atual`,
    nextStatus: "budget_reduced",
    newBudget,
  };
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// Aplica ação via google-ads-mutate (chamada interna como o próprio usuário)
async function applyAction(
  userJwt: string, campaignId: string,
  accountId: string | null, siteId: string | null,
  decision: Decision,
) {
  if (decision.action === "mark_failed" || decision.action === "mark_succeeded" || decision.action === "noop") return;

  const mutateUrl = `${SUPABASE_URL}/functions/v1/google-ads-mutate`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${userJwt}`,
  };

  let payload: Json | null = null;
  if (decision.action === "reduce_budget" || decision.action === "increase_budget") {
    payload = {
      action: "set_budget_absolute",
      campaign_id: campaignId,
      google_account_id: accountId,
      site_id: siteId,
      new_budget: decision.newBudget,
    };
  } else if (decision.action === "relax_cpa") {
    payload = {
      action: "set_target_cpa",
      campaign_id: campaignId,
      google_account_id: accountId,
      site_id: siteId,
      new_target_cpa: decision.newCpa,
    };
  }
  if (!payload) return;

  const res = await fetch(mutateUrl, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await res.text();
  if (!res.ok) throw new Error(`mutate ${res.status}: ${text.slice(0, 200)}`);
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* ignore */ }
  if (parsed?.error) throw new Error(String(parsed.error));
}
