// reconcile-placement-revenue
// ============================================================================
// Garante que sum(gam_placement_revenue) ≈ sum(gam_campaign_source_revenue)
// por (campaign_id, período) com tolerância configurável (default 3%).
//
// Modos:
//   - "audit"   → só compara e grava em placement_revenue_audit
//   - "rebuild" → invoca gam-sync-revenue p/ refazer parsing/match e re-audita
//   - "cron"    → varre todos os user/site/campanha ativos das últimas 24h
//
// Status:
//   verified       → leak < 3% & confidence >= 95
//   partial        → leak entre 3% e 10%
//   leak_detected  → leak entre 10% e 30%
//   unreliable     → leak > 30%
//   unknown        → não há receita no GAM no período (nada a auditar)
//
// IMPORTANTE: nunca decidimos "bad placement" aqui. Só dizemos se a base é confiável.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

type AuditStatus = "verified" | "partial" | "leak_detected" | "unreliable" | "unknown";

interface Body {
  mode?: "audit" | "rebuild" | "cron";
  user_id?: string;
  site_id?: string | null;
  campaign_ids?: string[];
  period_start?: string; // YYYY-MM-DD
  period_end?: string;   // YYYY-MM-DD
  tolerance_pct?: number; // default 3
  rebuild_threshold_pct?: number; // default 10 — se leak ≥, dispara rebuild
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SR);

  let body: Body = {};
  try { body = await req.json(); } catch { body = {}; }

  const mode = body.mode ?? "audit";
  const tol = Number.isFinite(body.tolerance_pct) ? Number(body.tolerance_pct) : 3;
  const rebuildThreshold = Number.isFinite(body.rebuild_threshold_pct) ? Number(body.rebuild_threshold_pct) : 10;

  // --- janela padrão: últimos 7 dias ---
  const today = new Date();
  const defEnd = today.toISOString().slice(0, 10);
  const defStart = new Date(today.getTime() - 6 * 86400_000).toISOString().slice(0, 10);
  const periodStart = body.period_start ?? defStart;
  const periodEnd = body.period_end ?? defEnd;

  // ============================ MODO CRON ===================================
  if (mode === "cron") {
    // pega campanhas com receita GAM nos últimos 2 dias
    const since = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const { data: src, error } = await admin
      .from("gam_campaign_source_revenue")
      .select("user_id, site_id, campaign_id")
      .gte("date", since);
    if (error) return jerr(error.message);

    const buckets = new Map<string, { user_id: string; site_id: string | null; campaign_id: string }>();
    for (const r of src ?? []) {
      const k = `${r.user_id}|${r.site_id ?? ""}|${r.campaign_id}`;
      if (!buckets.has(k)) buckets.set(k, { user_id: r.user_id, site_id: r.site_id, campaign_id: r.campaign_id });
    }

    const results: any[] = [];
    for (const b of buckets.values()) {
      const r = await auditOne(admin, {
        user_id: b.user_id, site_id: b.site_id, campaign_id: b.campaign_id,
        period_start: periodStart, period_end: periodEnd, tol, rebuildThreshold,
        rebuild_if_needed: true, SUPABASE_URL, SR,
      });
      results.push(r);
    }
    return jok({ mode, audited: results.length, summary: summarize(results) });
  }

  // ====================== MODO AUDIT / REBUILD ==============================
  let effectiveUserId = body.user_id;
  if (!effectiveUserId) {
    // tenta resolver via JWT do caller
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (token) {
      const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data: u } = await userClient.auth.getUser();
      if (u?.user?.id) effectiveUserId = u.user.id;
    }
  }
  if (!effectiveUserId) return jerr("user_id required");
  const userId = effectiveUserId;
  let campaignIds = body.campaign_ids ?? [];

  if (!campaignIds.length) {
    // pega todas as campanhas com receita GAM nesse user/site/período
    let q = admin.from("gam_campaign_source_revenue")
      .select("campaign_id")
      .eq("user_id", body.user_id)
      .gte("date", periodStart).lte("date", periodEnd);
    if (body.site_id) q = q.eq("site_id", body.site_id);
    const { data, error } = await q;
    if (error) return jerr(error.message);
    campaignIds = Array.from(new Set((data ?? []).map((r) => String(r.campaign_id))));
  }

  const results: any[] = [];
  for (const cid of campaignIds) {
    const r = await auditOne(admin, {
      user_id: body.user_id, site_id: body.site_id ?? null, campaign_id: cid,
      period_start: periodStart, period_end: periodEnd, tol, rebuildThreshold,
      rebuild_if_needed: mode === "rebuild",
      SUPABASE_URL, SR,
    });
    results.push(r);
  }
  return jok({ mode, period: { from: periodStart, to: periodEnd }, results, summary: summarize(results) });
});

// ----------------------------------------------------------------------------
async function auditOne(admin: any, args: {
  user_id: string; site_id: string | null; campaign_id: string;
  period_start: string; period_end: string;
  tol: number; rebuildThreshold: number; rebuild_if_needed: boolean;
  SUPABASE_URL: string; SR: string;
}) {
  const { user_id, site_id, campaign_id, period_start, period_end, tol, rebuildThreshold, rebuild_if_needed, SUPABASE_URL, SR } = args;
  const findings: any[] = [];

  // 1) Receita canônica (campanha agregada)
  let cq = admin.from("gam_campaign_source_revenue")
    .select("revenue_usd, date, site_id")
    .eq("user_id", user_id)
    .eq("campaign_id", campaign_id)
    .gte("date", period_start).lte("date", period_end);
  if (site_id) cq = cq.eq("site_id", site_id);
  const { data: camp, error: e1 } = await cq;
  if (e1) return { campaign_id, error: e1.message };

  const campaignRev = (camp ?? []).reduce((s: number, r: any) => s + num(r.revenue_usd), 0);
  const campaignDays = new Set((camp ?? []).map((r: any) => r.date));
  const campaignSites = new Set((camp ?? []).map((r: any) => r.site_id).filter(Boolean));

  // 2) Receita placement
  let pq = admin.from("gam_placement_revenue")
    .select("revenue_usd, date, site_id, placement, raw_utm, utm_source")
    .eq("user_id", user_id)
    .eq("campaign_id", campaign_id)
    .gte("date", period_start).lte("date", period_end);
  if (site_id) pq = pq.eq("site_id", site_id);
  const { data: pls, error: e2 } = await pq;
  if (e2) return { campaign_id, error: e2.message };

  const placementRev = (pls ?? []).reduce((s: number, r: any) => s + num(r.revenue_usd), 0);
  const placementDays = new Set((pls ?? []).map((r: any) => r.date));
  const placementSites = new Set((pls ?? []).map((r: any) => r.site_id).filter(Boolean));

  // 3) Caso sem receita
  if (campaignRev <= 0) {
    const row = await upsertAudit(admin, {
      user_id, site_id, campaign_id, period_start, period_end,
      campaign_revenue_usd: 0, placements_revenue_usd: placementRev,
      leak_amount_usd: 0, leak_percent: 0, confidence: placementRev === 0 ? 100 : 0,
      audit_status: "unknown",
      parser_success_pct: null, match_success_pct: null,
      site_match_pct: null, period_match_pct: null,
      orphan_rows: 0, findings: [{ code: "no_campaign_revenue", message: "Sem receita GAM no período." }],
      rebuilt: false, rebuild_summary: null,
    });
    return row;
  }

  // 4) Métricas
  const leakAbs = campaignRev - placementRev;
  const leakPct = (leakAbs / campaignRev) * 100;
  const matchSuccess = Math.max(0, Math.min(100, 100 - Math.abs(leakPct)));

  // parser success: % de linhas com raw_utm contendo "utm_placement="
  const parsedRows = (pls ?? []).filter((r: any) => typeof r.raw_utm === "string" && r.raw_utm.includes("utm_placement="));
  const parserSuccessPct = pls && pls.length ? (parsedRows.length / pls.length) * 100 : null;

  // site match
  let siteMatchPct: number | null = null;
  if (campaignSites.size > 0 && placementSites.size > 0) {
    const inter = [...placementSites].filter((s) => campaignSites.has(s)).length;
    siteMatchPct = (inter / placementSites.size) * 100;
  }

  // period match
  let periodMatchPct: number | null = null;
  if (campaignDays.size > 0) {
    const inter = [...placementDays].filter((d) => campaignDays.has(d)).length;
    periodMatchPct = (inter / campaignDays.size) * 100;
  }

  // confidence: pondera reconciliação + parsing + site + period
  const conf = computeConfidence({ matchSuccess, parserSuccessPct, siteMatchPct, periodMatchPct, orphan: 0 });

  // findings de investigação
  if (Math.abs(leakPct) > rebuildThreshold) {
    if ((pls ?? []).length === 0) findings.push({ code: "no_placement_rows", message: "Zero linhas em gam_placement_revenue — matcher não rodou ou filtrou tudo." });
    if (parserSuccessPct !== null && parserSuccessPct < 90) findings.push({ code: "parser_low", message: `Parser baixo (${parserSuccessPct?.toFixed(1)}%) — utm_placement ausente em parte das linhas.` });
    if (siteMatchPct !== null && siteMatchPct < 80) findings.push({ code: "site_mismatch", message: `Site não bate (${siteMatchPct?.toFixed(1)}%) entre campaign e placement.` });
    if (periodMatchPct !== null && periodMatchPct < 80) findings.push({ code: "period_mismatch", message: `Dias com placement não cobrem dias com receita (${periodMatchPct?.toFixed(1)}%).` });
    // aggregated rows (GAM devolve linhas sem placement, atribui tudo na agregada)
    const orphanLikely = campaignRev > placementRev * 1.5;
    if (orphanLikely) findings.push({ code: "aggregate_only", message: "Diferença grande sugere linhas agregadas do GAM sem detalhamento de placement." });
  }

  const status: AuditStatus = decideStatus(leakPct, conf, tol);

  // 5) REBUILD MODE — se necessário e habilitado
  let rebuilt = false;
  let rebuildSummary: any = null;
  if (rebuild_if_needed && Math.abs(leakPct) >= rebuildThreshold) {
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/gam-sync-revenue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SR}` },
        body: JSON.stringify({
          user_id, site_id, campaign_ids: [campaign_id],
          from: period_start, to: period_end, force_rebuild: true,
        }),
      });
      rebuildSummary = await r.json().catch(() => ({ http: r.status }));
      rebuilt = r.ok;
    } catch (err) {
      rebuildSummary = { error: String((err as Error).message ?? err) };
    }

    // re-medir após rebuild
    if (rebuilt) {
      const { data: pls2 } = await admin.from("gam_placement_revenue")
        .select("revenue_usd").eq("user_id", user_id).eq("campaign_id", campaign_id)
        .gte("date", period_start).lte("date", period_end);
      const newPlacementRev = (pls2 ?? []).reduce((s: number, r: any) => s + num(r.revenue_usd), 0);
      const newLeakAbs = campaignRev - newPlacementRev;
      const newLeakPct = (newLeakAbs / campaignRev) * 100;
      const newConf = computeConfidence({
        matchSuccess: Math.max(0, Math.min(100, 100 - Math.abs(newLeakPct))),
        parserSuccessPct, siteMatchPct, periodMatchPct, orphan: 0,
      });
      const newStatus = decideStatus(newLeakPct, newConf, tol);
      findings.push({ code: "post_rebuild", before: { leakPct, conf }, after: { leakPct: newLeakPct, conf: newConf, status: newStatus } });
      const row = await upsertAudit(admin, {
        user_id, site_id, campaign_id, period_start, period_end,
        campaign_revenue_usd: campaignRev, placements_revenue_usd: newPlacementRev,
        leak_amount_usd: newLeakAbs, leak_percent: newLeakPct, confidence: newConf,
        audit_status: newStatus,
        parser_success_pct: parserSuccessPct, match_success_pct: Math.max(0, 100 - Math.abs(newLeakPct)),
        site_match_pct: siteMatchPct, period_match_pct: periodMatchPct,
        orphan_rows: 0, findings,
        rebuilt: true, rebuild_summary: rebuildSummary,
      });
      return row;
    }
  }

  const row = await upsertAudit(admin, {
    user_id, site_id, campaign_id, period_start, period_end,
    campaign_revenue_usd: campaignRev, placements_revenue_usd: placementRev,
    leak_amount_usd: leakAbs, leak_percent: leakPct, confidence: conf,
    audit_status: status,
    parser_success_pct: parserSuccessPct, match_success_pct: matchSuccess,
    site_match_pct: siteMatchPct, period_match_pct: periodMatchPct,
    orphan_rows: 0, findings,
    rebuilt, rebuild_summary: rebuildSummary,
  });
  return row;
}

function computeConfidence(x: { matchSuccess: number; parserSuccessPct: number | null; siteMatchPct: number | null; periodMatchPct: number | null; orphan: number }) {
  const parts: number[] = [];
  parts.push(x.matchSuccess * 0.55);                          // peso 55%
  parts.push((x.parserSuccessPct ?? 100) * 0.20);             // 20%
  parts.push((x.siteMatchPct ?? 100) * 0.15);                 // 15%
  parts.push((x.periodMatchPct ?? 100) * 0.10);               // 10%
  let conf = parts.reduce((a, b) => a + b, 0);
  if (x.orphan > 0) conf -= Math.min(10, x.orphan);
  return Math.max(0, Math.min(100, Math.round(conf * 10) / 10));
}

function decideStatus(leakPct: number, conf: number, tol: number): AuditStatus {
  const abs = Math.abs(leakPct);
  if (abs <= tol && conf >= 95) return "verified";
  if (abs <= 10) return "partial";
  if (abs <= 30) return "leak_detected";
  return "unreliable";
}

async function upsertAudit(admin: any, p: any) {
  // upsert por (user_id, campaign_id, period_start, period_end)
  const { data: existing } = await admin
    .from("placement_revenue_audit")
    .select("id")
    .eq("user_id", p.user_id).eq("campaign_id", p.campaign_id)
    .eq("period_start", p.period_start).eq("period_end", p.period_end)
    .maybeSingle();

  // pega nome da campanha
  const { data: cn } = await admin.from("campaigns").select("name, google_account_id")
    .eq("user_id", p.user_id).eq("campaign_id", p.campaign_id).maybeSingle();
  const payload = { ...p, campaign_name: cn?.name ?? null, google_account_id: cn?.google_account_id ?? null };

  if (existing?.id) {
    const { data, error } = await admin.from("placement_revenue_audit")
      .update(payload).eq("id", existing.id).select().maybeSingle();
    if (error) return { ...payload, error: error.message };
    return data;
  }
  const { data, error } = await admin.from("placement_revenue_audit")
    .insert(payload).select().maybeSingle();
  if (error) return { ...payload, error: error.message };
  return data;
}

function summarize(rs: any[]) {
  const out: Record<string, number> = { verified: 0, partial: 0, leak_detected: 0, unreliable: 0, unknown: 0, error: 0 };
  for (const r of rs) {
    if (r?.error) out.error++;
    else out[r?.audit_status ?? "unknown"] = (out[r?.audit_status ?? "unknown"] ?? 0) + 1;
  }
  return out;
}

function jok(data: unknown) { return new Response(JSON.stringify(data), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }); }
function jerr(message: string, status = 400) { return new Response(JSON.stringify({ error: message }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status }); }
