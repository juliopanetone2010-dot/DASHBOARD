// Avaliador inteligente de placements (esteira de decisão).
// - Lê custo do Google Ads (ads_placements) e receita do GAM (gam_placement_revenue)
//   pelos últimos N dias (lookback_days, padrão 30).
// - Aplica funil de status (test → learning → good/bad → blocked) usando os
//   limiares definidos em rules_config.funnel_*.
// - Atualiza placement_status, registra placement_status_history e protege
//   placements novos / com pouco volume / com conversão recente.
// - Quando mode = "apply", chama placements-cleanup para apenas os placements
//   recém-marcados como 'blocked'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const REV_SHARE_NET = 0.935;
const KEY_SEP = "\u0001";

type Phase = "phase1_test" | "phase2_learning" | "phase3_decision" | "phase4_block";
type Status = "test" | "learning" | "good" | "bad" | "blocked";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SR);

    const authHeader = req.headers.get("Authorization") ?? "";
    const isService = authHeader.includes(SR);
    const body = await req.json().catch(() => ({}));
    const mode: "preview" | "apply" = body?.mode ?? "preview";
    const lookbackDays = Math.max(1, Math.min(180, Number(body?.lookback_days ?? 30)));
    const fxUsdBrl = Number(body?.fx_usd_brl ?? 5);
    const targetUserId: string | undefined = body?.user_id;
    const explicitFrom: string | undefined = typeof body?.from === "string" ? body.from : undefined;
    const explicitTo: string | undefined = typeof body?.to === "string" ? body.to : undefined;

    let userId: string | null = null;
    if (isService && targetUserId) userId = targetUserId;
    else {
      if (!authHeader.startsWith("Bearer ")) return json({ error: "Login obrigatório" });
      const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
      userId = claims?.claims?.sub ?? null;
      if (!userId) return json({ error: "Token inválido" });
    }

    // Carrega regras
    const { data: rules } = await admin.from("rules_config")
      .select("funnel_test_max_cost, funnel_learning_max_cost, funnel_learning_min_roi, funnel_decision_good_roi, funnel_decision_bad_roi, funnel_block_min_cost, funnel_block_max_roi, funnel_scale_min_roi, funnel_protect_min_clicks, funnel_protect_recent_conv_days")
      .eq("user_id", userId).maybeSingle();
    const R = {
      testMaxCost: Number(rules?.funnel_test_max_cost ?? 30),
      learningMaxCost: Number(rules?.funnel_learning_max_cost ?? 100),
      learningMinRoi: Number(rules?.funnel_learning_min_roi ?? -40),
      goodRoi: Number(rules?.funnel_decision_good_roi ?? 20),
      badRoi: Number(rules?.funnel_decision_bad_roi ?? -20),
      blockMinCost: Number(rules?.funnel_block_min_cost ?? 150),
      blockMaxRoi: Number(rules?.funnel_block_max_roi ?? -30),
      scaleMinRoi: Number(rules?.funnel_scale_min_roi ?? 30),
      protectMinClicks: Number(rules?.funnel_protect_min_clicks ?? 10),
      protectRecentConvDays: Number(rules?.funnel_protect_recent_conv_days ?? 3),
    };

    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    // Sem janela explícita, usa dias completos como a Dashboard: até ontem.
    const toDate = new Date(today.getTime() - 86400_000);
    const fromDate = new Date(toDate.getTime() - (lookbackDays - 1) * 86400_000);
    const recentConvCutoff = new Date(today.getTime() - R.protectRecentConvDays * 86400_000);
    const from = explicitFrom ?? iso(fromDate);
    const to = explicitTo ?? iso(toDate);
    const recentCut = iso(recentConvCutoff);

    // Campanhas (todas, não só enabled — para manter histórico)
    const { data: camps } = await admin.from("campaigns")
      .select("campaign_id, name, google_account_id, status")
      .eq("user_id", userId);
    const campMap = new Map<string, { name: string; google_account_id: string | null; status: string }>();
    for (const c of camps ?? []) campMap.set(String(c.campaign_id), { name: c.name, google_account_id: c.google_account_id, status: c.status });

    // ads_placements (custo + cliques + conversões + datas)
    type AdsRow = { campaign_id: string; placement: string; placement_clean: string | null; placement_type: string | null; cost: number; clicks: number; impressions: number; conversions: number; date: string };
    const ads: AdsRow[] = [];
    let s = 0;
    for (;;) {
      const { data, error } = await admin.from("ads_placements")
        .select("campaign_id, placement, placement_clean, placement_type, cost, clicks, impressions, conversions, date")
        .eq("user_id", userId).gte("date", from).lte("date", to)
        .range(s, s + 999);
      if (error) return json({ error: error.message });
      const rows = (data ?? []) as AdsRow[];
      ads.push(...rows);
      if (rows.length < 1000) break;
      s += 1000;
    }

    // gam_placement_revenue
    type GamRow = { campaign_id: string; placement: string; revenue_usd: number; date: string };
    const gam: GamRow[] = [];
    s = 0;
    for (;;) {
      const { data, error } = await admin.from("gam_placement_revenue")
        .select("campaign_id, placement, revenue_usd, date")
        .eq("user_id", userId).gte("date", from).lte("date", to)
        .range(s, s + 999);
      if (error) return json({ error: error.message });
      const rows = (data ?? []) as GamRow[];
      gam.push(...rows);
      if (rows.length < 1000) break;
      s += 1000;
    }

    const revByCampaign = new Map<string, Map<string, number>>();
    for (const g of gam) {
      const placement = normalize(g.placement);
      if (!placement) continue;
      const cid = String(g.campaign_id);
      const inner = revByCampaign.get(cid) ?? new Map<string, number>();
      inner.set(placement, (inner.get(placement) ?? 0) + Number(g.revenue_usd ?? 0));
      revByCampaign.set(cid, inner);
    }

    interface Agg { campaign_id: string; placement: string; type: string; cost: number; clicks: number; impressions: number; conversions: number; lastConvDate: string | null; firstDate: string; }
    const agg = new Map<string, Agg>();
    for (const r of ads) {
      const placement = normalize(r.placement_clean || r.placement, r.placement_type);
      if (!placement) continue;
      const k = cpKey(r.campaign_id, placement);
      let a = agg.get(k);
      if (!a) {
        a = { campaign_id: r.campaign_id, placement, type: r.placement_type ?? "—", cost: 0, clicks: 0, impressions: 0, conversions: 0, lastConvDate: null, firstDate: r.date };
        agg.set(k, a);
      }
      a.cost += Number(r.cost) || 0;
      a.clicks += Number(r.clicks) || 0;
      a.impressions += Number(r.impressions) || 0;
      const conv = Number(r.conversions) || 0;
      a.conversions += conv;
      if (conv > 0) a.lastConvDate = a.lastConvDate && a.lastConvDate > r.date ? a.lastConvDate : r.date;
      if (r.date < a.firstDate) a.firstDate = r.date;
    }

    // Carrega status atuais
    const { data: existing } = await admin.from("placement_status")
      .select("id, campaign_id, placement, placement_type, status, manual_override, prev_roi_pct, roi_pct, first_seen_at, last_status_change_at, blocked_at")
      .eq("user_id", userId);
    const existMap = new Map<string, any>();
    for (const e of existing ?? []) existMap.set(cpKey(e.campaign_id, e.placement), e);

    // Carrega placements já excluídos manualmente / pelo cleanup antigo
    // (placement_actions.action='blacklist'). Eles devem aparecer no funil
    // como 'blocked' mesmo sem dados recentes — isso preserva o histórico
    // de exclusões e evita "ressurreição" como test/learning.
    const blacklisted = new Set<string>();
    {
      let bs = 0;
      for (;;) {
        const { data, error } = await admin.from("placement_actions")
          .select("campaign_id, placement")
          .eq("user_id", userId).eq("action", "blacklist")
          .range(bs, bs + 999);
        if (error) return json({ error: error.message });
        const rows = data ?? [];
        for (const r of rows) {
          const placement = normalize(String(r.placement ?? ""));
          if (r.campaign_id && placement) blacklisted.add(cpKey(String(r.campaign_id), placement));
        }
        if (rows.length < 1000) break;
        bs += 1000;
      }
    }

    // Garante que todo placement já blacklistado tenha entry em agg
    for (const k of blacklisted) {
      if (agg.has(k)) continue;
      const [campaign_id, placement] = k.split(KEY_SEP);
      const ex = existMap.get(k);
      agg.set(k, {
        campaign_id, placement,
        type: ex?.placement_type ?? "WEBSITE",
        cost: 0,
        clicks: 0,
        impressions: 0,
        conversions: 0,
        lastConvDate: null,
        firstDate: ex?.first_seen_at ? String(ex.first_seen_at).slice(0, 10) : from,
      });
    }

    const upserts: any[] = [];
    const histInserts: any[] = [];
    const newlyBlocked: Array<{ campaign_id: string; placement: string; placement_type: string; cost_brl: number; revenue_brl: number; roi_pct: number; google_account_id: string | null; campaign_name: string }> = [];
    const summary = { total: 0, test: 0, learning: 0, good: 0, bad: 0, blocked: 0, protected: 0, scaled: 0, transitions: 0 };

    for (const a of agg.values()) {
      const meta = campMap.get(a.campaign_id);
      if (!meta) continue;
      const k = cpKey(a.campaign_id, a.placement);
      const campaignRevenue = revByCampaign.get(a.campaign_id) ?? new Map<string, number>();
      const root = rootDomain(a.placement);
      let usd = campaignRevenue.get(a.placement) ?? 0;
      if (usd <= 0 && root && root !== a.placement) usd = campaignRevenue.get(root) ?? 0;
      const revenue_brl = usd * REV_SHARE_NET * fxUsdBrl;
      const profit = revenue_brl - a.cost;
      const roi = a.cost > 0 ? (profit / a.cost) * 100 : 0;

      const ex = existMap.get(k);
      const prevStatus: Status | null = ex?.status ?? null;
      const prevRoi: number | null = ex?.prev_roi_pct ?? ex?.roi_pct ?? null;
      const isManual = !!ex?.manual_override;

      // Proteção: pouco volume OU conversão recente
      const lowVolume = a.clicks < R.protectMinClicks;
      const hasRecentConv = !!a.lastConvDate && a.lastConvDate >= recentCut;
      const protectedNow = lowVolume || hasRecentConv;

      // Funil
      let phase: Phase = "phase1_test";
      let status: Status = "test";
      let reason = "";
      let priority = false;

      if (a.cost < R.testMaxCost) {
        phase = "phase1_test"; status = "test";
        reason = `custo ${a.cost.toFixed(2)} < ${R.testMaxCost}`;
      } else if (a.cost < R.learningMaxCost) {
        phase = "phase2_learning";
        if (roi > R.learningMinRoi) { status = "learning"; reason = `learning: roi ${roi.toFixed(1)}% > ${R.learningMinRoi}%`; }
        else { status = "bad"; reason = `bad early: roi ${roi.toFixed(1)}% <= ${R.learningMinRoi}%`; }
      } else {
        phase = "phase3_decision";
        if (roi >= R.goodRoi) {
          status = "good"; reason = `good: roi ${roi.toFixed(1)}% >= ${R.goodRoi}%`;
          if (roi >= R.scaleMinRoi && a.cost >= R.learningMaxCost) priority = true;
        } else if (roi <= R.badRoi) {
          status = "bad"; reason = `bad: roi ${roi.toFixed(1)}% <= ${R.badRoi}%`;
        } else {
          status = "learning"; reason = `learning grey zone: roi ${roi.toFixed(1)}%`;
        }

        // Fase 4 — bloqueio definitivo
        if (status === "bad" && a.cost >= R.blockMinCost && roi <= R.blockMaxRoi) {
          phase = "phase4_block"; status = "blocked";
          reason = `BLOCK: cost ${a.cost.toFixed(2)} >= ${R.blockMinCost} && roi ${roi.toFixed(1)}% <= ${R.blockMaxRoi}%`;
        }
      }

      // Segunda chance: se era bad e ROI subiu (>5pp) → learning
      if (prevStatus === "bad" && prevRoi !== null && roi - prevRoi > 5 && status === "bad" && phase !== "phase4_block") {
        status = "learning";
        reason = `2nd chance: roi subiu ${(roi - prevRoi).toFixed(1)}pp (${prevRoi.toFixed(1)}→${roi.toFixed(1)}) - voltou pra learning`;
      }

      // Proteção sobrepõe bloqueio automático (mas não sobrepõe override manual)
      if (protectedNow && status === "blocked" && !isManual) {
        status = "bad"; phase = "phase3_decision";
        reason = `protegido (${lowVolume ? "low_volume" : ""}${lowVolume && hasRecentConv ? "+" : ""}${hasRecentConv ? "recent_conv" : ""}): bloqueio adiado`;
      }

      // Override manual ganha
      if (isManual && prevStatus) status = prevStatus;

      // Já bloqueado historicamente (placement_actions.blacklist) → permanece blocked
      if (blacklisted.has(k) && !isManual) {
        status = "blocked";
        phase = "phase4_block";
        if (prevStatus !== "blocked") reason = `legacy blacklist: já excluído anteriormente`;
      }

      summary.total++;
      summary[status]++;
      if (protectedNow) summary.protected++;
      if (priority) summary.scaled++;

      const statusChanged = prevStatus !== status;
      if (statusChanged) summary.transitions++;

      const nowIso = new Date().toISOString();
      const fd = a.firstDate ? new Date(a.firstDate) : null;
      const firstSeen = ex?.first_seen_at ?? (fd && !isNaN(fd.getTime()) ? fd.toISOString() : nowIso);
      const row: any = {
        user_id: userId,
        google_account_id: meta.google_account_id,
        campaign_id: a.campaign_id,
        campaign_name: meta.name,
        placement: a.placement,
        placement_type: a.type,
        status, phase, reason,
        priority,
        cost_total: round(a.cost),
        revenue_total: round(revenue_brl),
        profit_total: round(profit),
        roi_pct: round(roi),
        clicks_total: a.clicks,
        impressions_total: a.impressions,
        conversions_total: a.conversions,
        prev_roi_pct: ex?.roi_pct ?? null,
        last_evaluated_at: nowIso,
        first_seen_at: firstSeen,
        last_status_change_at: ex?.last_status_change_at ?? nowIso,
        blocked_at: ex?.blocked_at ?? null,
      };
      if (statusChanged) row.last_status_change_at = nowIso;
      if (status === "blocked" && (!ex || ex.status !== "blocked")) row.blocked_at = nowIso;
      // remove undefined
      for (const k2 of Object.keys(row)) if (row[k2] === undefined) delete row[k2];
      upserts.push(row);

      if (statusChanged) {
        histInserts.push({
          user_id: userId,
          placement_status_id: ex?.id ?? null,
          campaign_id: a.campaign_id,
          placement: a.placement,
          from_status: prevStatus,
          to_status: status,
          reason,
          cost_total: round(a.cost),
          revenue_total: round(revenue_brl),
          roi_pct: round(roi),
          triggered_by: "auto",
        });
      }

      if (status === "blocked" && (!ex || ex.status !== "blocked")) {
        newlyBlocked.push({
          campaign_id: a.campaign_id,
          placement: a.placement,
          placement_type: a.type,
          cost_brl: round(a.cost),
          revenue_brl: round(revenue_brl),
          roi_pct: round(roi),
          google_account_id: meta.google_account_id,
          campaign_name: meta.name,
        });
      }
    }

    // Upsert (em chunks)
    for (const chunk of chunkArr(upserts, 500)) {
      const { error } = await admin.from("placement_status")
        .upsert(chunk, { onConflict: "user_id,campaign_id,placement" });
      if (error) return json({ error: error.message });
    }
    // Backfill placement_status_id no histórico (após upsert)
    if (histInserts.length) {
      const keys = histInserts.map((h) => [h.campaign_id, h.placement]);
      const { data: ids } = await admin.from("placement_status")
        .select("id, campaign_id, placement")
        .eq("user_id", userId)
        .in("campaign_id", [...new Set(keys.map((k) => k[0]))]);
      const idMap = new Map<string, string>();
      for (const i of ids ?? []) idMap.set(cpKey(i.campaign_id, i.placement), i.id);
      for (const h of histInserts) {
        h.placement_status_id = idMap.get(cpKey(h.campaign_id, h.placement)) ?? null;
      }
      const valid = histInserts.filter((h) => h.placement_status_id);
      for (const chunk of chunkArr(valid, 500)) {
        await admin.from("placement_status_history").insert(chunk);
      }
    }

    let blockResult: any = null;
    if (mode === "apply" && newlyBlocked.length > 0) {
      const items = newlyBlocked.map((b) => ({
        placement: b.placement,
        type: b.placement_type,
        cost_brl: b.cost_brl,
        revenue_brl: b.revenue_brl,
        roi_pct: b.roi_pct,
        reason: "funnel_block",
        campaigns: [{ campaign_id: b.campaign_id, google_account_id: b.google_account_id ?? "", cost_brl: b.cost_brl, roi_pct: b.roi_pct }],
      }));
      const r = await fetch(`${SUPABASE_URL}/functions/v1/placements-cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SR}` },
        body: JSON.stringify({ mode: "apply", user_id: userId, items, min_cost_brl: 0, min_days: 0 }),
      });
      blockResult = await r.json().catch(() => ({}));
    }

    return json({
      ok: true, mode, period: { from, to }, summary,
      newly_blocked: newlyBlocked.length,
      block_apply: blockResult,
    });
  } catch (e) {
    console.error("[placements-evaluate]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});

function cpKey(cid: string, placement: string) { return `${cid}${KEY_SEP}${placement}`; }
function chunkArr<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out;
}
function round(n: number) { return Math.round(n * 100) / 100; }
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
function json(p: unknown) {
  return new Response(JSON.stringify(p), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
