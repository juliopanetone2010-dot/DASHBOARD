// Cron diário (e trigger manual) da esteira inteligente de campanhas.
// - Lê daily_metrics (já populado por google-ads-sync-campaigns + gam-sync-revenue)
// - Calcula ROI dos últimos N dias com NET_FACTOR (mesma lógica do dashboard)
// - Classifica em: testing | learning | standby | scaling | bad | paused
// - Decide ação (pause | scale | cpa_up | cpa_down | none) respeitando cooldowns
// - DRY-RUN por padrão: só grava em automation_logs, não chama Google Ads
// - Quando dry-run=false, dispara google-ads-mutate
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const NET_FACTOR = 0.935;

type Lifecycle = "testing" | "learning" | "standby" | "scaling" | "bad" | "paused";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({} as any));
    const force = !!body?.force;          // ignora cooldown e roda mesmo desabilitado
    let onlyUserId: string | undefined = body?.user_id;

    // Se chamado com Authorization de um usuário (botão "Rodar agora"), restringe àquele user
    const authHeader = req.headers.get("Authorization");
    let userJwt: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
      const sub = claims?.claims?.sub;
      if (sub) { onlyUserId = sub; userJwt = authHeader.replace("Bearer ", ""); }
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Busca todas as configs (cron multiusuário) ou só de um user
    let q = admin.from("rules_config").select("*");
    if (onlyUserId) q = q.eq("user_id", onlyUserId);
    const { data: configs, error: cfgErr } = await q;
    if (cfgErr) throw cfgErr;

    const summary: any[] = [];
    for (const cfg of configs ?? []) {
      if (!force && !cfg.automation_enabled) {
        summary.push({ user_id: cfg.user_id, skipped: "automation_disabled" });
        continue;
      }
      const result = await runForUser(admin, cfg, userJwt);
      summary.push({ user_id: cfg.user_id, ...result });
      await admin
        .from("rules_config")
        .update({ automation_last_run_at: new Date().toISOString() })
        .eq("user_id", cfg.user_id);
    }

    return json({ ok: true, runs: summary });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

async function runForUser(admin: any, cfg: any, userJwt: string | null) {
  const userId = cfg.user_id;
  const dryRun: boolean = cfg.automation_dry_run !== false;
  const days: number = Math.max(1, Number(cfg.auto_analysis_days) || 7);

  // Janela: dia anterior a hoje (sempre até ontem)
  const today = new Date();
  const yest = new Date(today); yest.setUTCDate(today.getUTCDate() - 1);
  const from = new Date(today); from.setUTCDate(today.getUTCDate() - days);
  const fromIso = isoDate(from);
  const toIso = isoDate(yest);

  const { data: metrics } = await admin
    .from("daily_metrics")
    .select("campaign_id, google_account_id, date, spend, profit, clicks, conversions, impressions")
    .eq("user_id", userId)
    .gte("date", fromIso)
    .lte("date", toIso)
    .limit(50000);

  // Agrega por campanha — usa SOMENTE daily_metrics (mesma fonte da tabela de campanhas do dashboard).
  // Receita extra (push/outras UTMs do GAM) entra só no total agregado do dashboard, não por campanha,
  // então também NÃO somamos aqui — assim o ROI bate exatamente com a coluna ROI do dashboard.
  const byCamp = new Map<string, {
    campaign_id: string; google_account_id: string | null;
    spend: number; grossRevBrl: number; days: Set<string>;
    daily: { date: string; spend: number; profit: number; roi: number }[];
  }>();
  for (const r of metrics ?? []) {
    const cid = String(r.campaign_id);
    let agg = byCamp.get(cid);
    if (!agg) { agg = { campaign_id: cid, google_account_id: r.google_account_id ?? null, spend: 0, grossRevBrl: 0, days: new Set(), daily: [] }; byCamp.set(cid, agg); }
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

  // Carrega estado atual
  const { data: states } = await admin
    .from("campaign_automation").select("*").eq("user_id", userId);
  const stateByCamp = new Map<string, any>();
  for (const s of states ?? []) stateByCamp.set(s.campaign_id, s);

  // Carrega nomes de campanhas (status real)
  const { data: campRows } = await admin
    .from("campaigns").select("campaign_id, name, status").eq("user_id", userId);
  const campMeta = new Map<string, any>();
  for (const c of campRows ?? []) campMeta.set(c.campaign_id, c);

  let decisions = 0; let executed = 0; let skippedInactive = 0;
  for (const agg of byCamp.values()) {
    const meta = campMeta.get(agg.campaign_id);
    // Só avalia campanhas atualmente ATIVAS no Google Ads (enabled)
    const status = String(meta?.status ?? "").toLowerCase();
    if (!meta || (status !== "enabled" && status !== "active")) {
      skippedInactive++;
      continue;
    }
    const decision = classify(agg, cfg, stateByCamp.get(agg.campaign_id));
    decisions++;
    const prevState = stateByCamp.get(agg.campaign_id);
    const fromStatus: Lifecycle | null = prevState?.lifecycle_status ?? null;

    // Atualiza estado
    const nowIso = new Date().toISOString();
    const newState: any = {
      user_id: userId,
      campaign_id: agg.campaign_id,
      google_account_id: agg.google_account_id,
      lifecycle_status: decision.lifecycle,
      last_roi: round2(decision.roi),
      roi_trend: decision.trend,
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
    if (decision.action === "scale") {
      newState.last_scale_date = nowIso;
      newState.cooldown_until = new Date(Date.now() + (Number(cfg.auto_scale_interval_days) || 2) * 86400_000).toISOString();
    }
    if (decision.action === "cpa_up" || decision.action === "cpa_down") {
      newState.last_cpa_action = decision.action;
      newState.last_cpa_action_date = nowIso;
    }
    if (decision.action !== "none") {
      newState.last_action = decision.action;
      newState.last_action_date = nowIso;
    }

    await admin.from("campaign_automation").upsert(newState, { onConflict: "user_id,campaign_id" });

    // Executa (se não dry-run e ação real)
    let execStatus: "executed" | "dry_run" | "skipped" | "failed" = "dry_run";
    let execError: string | null = null;
    if (decision.action !== "none") {
      if (dryRun || !userJwt) execStatus = "dry_run";
      else {
        try {
          await applyMutation(userJwt, agg.campaign_id, decision, cfg);
          execStatus = "executed"; executed++;
        } catch (e) { execStatus = "failed"; execError = String(e instanceof Error ? e.message : e); }
      }
    } else {
      execStatus = "skipped";
    }

    await admin.from("automation_logs").insert({
      user_id: userId,
      campaign_id: agg.campaign_id,
      action: decision.action === "none" ? "classify" : decision.action,
      reason: decision.reason,
      decision: execStatus,
      roi: round2(decision.roi),
      cost: round2(agg.spend),
      revenue: round2(agg.grossRevBrl * NET_FACTOR),
      lifecycle_from: fromStatus,
      lifecycle_to: decision.lifecycle,
      payload: { trend: decision.trend, days: agg.days.size, name: meta?.name ?? null, daily: agg.daily.slice(-days) },
      error: execError,
    });
  }

  return { window: { from: fromIso, to: toIso }, dry_run: dryRun, campaigns: byCamp.size, decisions, executed, skipped_inactive: skippedInactive };
}

function classify(agg: any, cfg: any, prev: any): {
  lifecycle: Lifecycle; action: "none" | "pause" | "scale" | "cpa_up" | "cpa_down";
  reason: string; roi: number; trend: "up" | "down" | "flat";
} {
  const days = agg.days.size;
  const cost = agg.spend;
  const netRev = agg.grossRevBrl * NET_FACTOR;
  const roi = cost > 0 ? ((netRev - cost) / cost) * 100 : 0;

  // Tendência: compara primeira metade vs segunda metade da janela
  const sorted = [...agg.daily].sort((a, b) => a.date.localeCompare(b.date));
  const mid = Math.floor(sorted.length / 2);
  const avg = (arr: any[]) => arr.length ? arr.reduce((s, x) => s + x.roi, 0) / arr.length : 0;
  const r1 = avg(sorted.slice(0, mid));
  const r2 = avg(sorted.slice(mid));
  const diff = r2 - r1;
  const trend: "up" | "down" | "flat" = Math.abs(diff) < 5 ? "flat" : diff > 0 ? "up" : "down";

  // Proteções: dados insuficientes -> testing, sem ação
  if (days < Math.min(2, Number(cfg.auto_analysis_days) || 7) || cost < Number(cfg.auto_stoploss_min_cost)) {
    return { lifecycle: "testing", action: "none", reason: `Dados insuficientes (dias=${days}, custo=${round2(cost)})`, roi, trend };
  }

  // Em cooldown? não age (mas reclassifica)
  const inCooldown = prev?.cooldown_until && new Date(prev.cooldown_until) > new Date();

  // SCALING
  if (roi >= Number(cfg.auto_scale_min_roi)) {
    if (inCooldown) return { lifecycle: "scaling", action: "none", reason: `ROI ${round2(roi)}% em cooldown até ${prev.cooldown_until}`, roi, trend };
    return { lifecycle: "scaling", action: "scale", reason: `ROI ${round2(roi)}% ≥ ${cfg.auto_scale_min_roi}% → +${cfg.auto_scale_budget_pct}%`, roi, trend };
  }

  // STANDBY: ROI lateralizado
  const low = Number(cfg.auto_standby_roi_low);
  const high = Number(cfg.auto_standby_roi_high);
  if (roi >= low && roi <= high && days >= Number(cfg.auto_standby_enter_days)) {
    // Já em standby há muito tempo + roi negativo → pausa
    if (prev?.lifecycle_status === "standby") {
      const enteredAt = prev.entered_standby_at ? new Date(prev.entered_standby_at) : null;
      const daysIn = enteredAt ? Math.floor((Date.now() - enteredAt.getTime()) / 86400_000) : 0;
      if (daysIn >= Number(cfg.auto_standby_max_days) && roi < 0) {
        return { lifecycle: "paused", action: "pause", reason: `Standby ${daysIn}d com ROI ${round2(roi)}% < 0 → pausar`, roi, trend };
      }
    }
    return { lifecycle: "standby", action: "none", reason: `ROI ${round2(roi)}% lateral (${low}–${high}%) há ${days}d`, roi, trend };
  }

  // STOP LOSS: ROI abaixo do mínimo + dias suficientes + tendência ruim
  if (roi < Number(cfg.auto_stoploss_min_roi) && days >= Number(cfg.auto_stoploss_days) && trend !== "up") {
    return { lifecycle: "bad", action: "pause", reason: `ROI ${round2(roi)}% < ${cfg.auto_stoploss_min_roi}% por ${days}d (tendência ${trend}) → pausar`, roi, trend };
  }

  // CPA: ROI entre 0 e scale_min_roi → tenta CPA up
  if (roi >= 0 && roi < Number(cfg.auto_scale_min_roi)) {
    const lastCpa = prev?.last_cpa_action_date ? new Date(prev.last_cpa_action_date) : null;
    const daysSinceCpa = lastCpa ? Math.floor((Date.now() - lastCpa.getTime()) / 86400_000) : 999;
    if (daysSinceCpa < Number(cfg.auto_cpa_review_days)) {
      return { lifecycle: "learning", action: "none", reason: `Aguardando review de CPA (${daysSinceCpa}/${cfg.auto_cpa_review_days}d)`, roi, trend };
    }
    if (prev?.last_cpa_action === "cpa_up" && trend !== "up") {
      return { lifecycle: "learning", action: "cpa_down", reason: `CPA up não melhorou (trend ${trend}) → reduzir CPA -${cfg.auto_cpa_down_pct}%`, roi, trend };
    }
    return { lifecycle: "learning", action: "cpa_up", reason: `ROI ${round2(roi)}% entre 0 e ${cfg.auto_scale_min_roi}% → aumentar CPA +${cfg.auto_cpa_up_pct}%`, roi, trend };
  }

  return { lifecycle: "learning", action: "none", reason: `ROI ${round2(roi)}% — observando`, roi, trend };
}

async function applyMutation(userJwt: string, campaignId: string, decision: any, cfg: any) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`;
  const body: any = { campaign_id: campaignId };
  if (decision.action === "pause") { body.action = "set_status"; body.status = "PAUSED"; }
  else if (decision.action === "scale") { body.action = "adjust_budget"; body.delta_pct = Number(cfg.auto_scale_budget_pct) || 20; }
  else if (decision.action === "cpa_up") { body.action = "adjust_cpa"; body.delta_pct = Number(cfg.auto_cpa_up_pct) || 10; }
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
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
