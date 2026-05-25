// rebuild-canonical-placement-engine
// ============================================================================
// Reconstrói a tabela `placement_revenue_reconciled` usando utm_placement como
// SOURCE OF TRUTH. Etapas:
//   1) puxa rows do GAM (gam_placement_revenue) no período
//   2) extrai utm_placement do raw_utm
//   3) parse canonical key
//   4) consolida por (canonical_key, date)
//   5) upsert em placement_revenue_reconciled
//   6) calcula leak vs gam_campaign_source_revenue
//   7) retorna sumário (VERIFIED / PARTIAL / LEAK / BROKEN)
//
// CRÍTICO: somente rows com reconciliation_method = 'exact_utm_placement'
// devem ser usadas pelo placement cleanup.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { extractUtmPlacementFromRaw, reconcileRow, type CanonicalPlacement } from "../_shared/canonical_placement.ts";

interface Body {
  user_id?: string;
  site_id?: string | null;
  campaign_ids?: string[];
  period_start?: string;
  period_end?: string;
  tolerance_pct?: number;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SR);

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty */ }

  // resolve user
  let userId = body.user_id;
  if (!userId) {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token) {
      const uc = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data } = await uc.auth.getUser();
      if (data?.user?.id) userId = data.user.id;
    }
  }
  if (!userId) return jerr("user_id required");

  const today = new Date();
  const defEnd = today.toISOString().slice(0, 10);
  const defStart = new Date(today.getTime() - 6 * 86400_000).toISOString().slice(0, 10);
  const periodStart = body.period_start ?? defStart;
  const periodEnd = body.period_end ?? defEnd;
  const tol = Number.isFinite(body.tolerance_pct) ? Number(body.tolerance_pct) : 3;

  // 1) puxa rows de GAM (gam_placement_revenue) — PAGINADO (Supabase limita 1000/req)
  const PAGE = 1000;
  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = admin.from("gam_placement_revenue")
      .select("user_id, site_id, campaign_id, placement, date, revenue_usd, impressions, raw_utm, utm_source")
      .eq("user_id", userId)
      .gte("date", periodStart).lte("date", periodEnd)
      .order("date", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (body.site_id) q = q.eq("site_id", body.site_id);
    if (body.campaign_ids?.length) q = q.in("campaign_id", body.campaign_ids);
    const { data: page, error } = await q;
    if (error) return jerr(error.message);
    if (!page?.length) break;
    rows.push(...page);
    if (page.length < PAGE) break;
    if (rows.length > 500_000) break; // safety
  }


  const reconciled = new Map<string, {
    canon: CanonicalPlacement;
    user_id: string;
    site_id: string | null;
    date: string;
    revenue_usd: number;
    impressions: number;
    source_rows: number;
  }>();

  let brokenCount = 0;
  let placementRevenue = 0;
  let exactRevenue = 0;
  let inferredRevenue = 0;
  let brokenRevenue = 0;
  let withoutUtmRevenue = 0;
  const rawSamples: any[] = [];
  const methodCounts: Record<string, number> = {};

  for (const r of rows ?? []) {
    const revenue = num(r.revenue_usd);
    const rawUtmPlacement = extractUtmPlacementFromRaw(r.raw_utm);
    const canon = reconcileRow({
      rawUtm: r.raw_utm,
      campaignId: r.campaign_id,
      placement: r.placement,
    });
    methodCounts[canon.reconciliation_method] = (methodCounts[canon.reconciliation_method] ?? 0) + 1;
    if (canon.broken_tracking) brokenCount++;
    placementRevenue += revenue;
    if (canon.reconciliation_method === "exact_utm_placement") exactRevenue += revenue;
    else inferredRevenue += revenue;
    if (canon.broken_tracking) brokenRevenue += revenue;
    if (!rawUtmPlacement) withoutUtmRevenue += revenue;
    if (rawSamples.length < 25) {
      rawSamples.push({
        source_table: "gam_placement_revenue",
        raw_gam_row: r,
        raw_utm_placement: rawUtmPlacement,
        raw_url: null,
        raw_placement: r.placement ?? null,
        dimensions: { date: r.date, campaign_id: r.campaign_id, placement: r.placement, site_id: r.site_id, utm_source: r.utm_source },
        parser_result: canon,
      });
    }

    const key = `${canon.canonical_key}|${r.date}`;
    const cur = reconciled.get(key);
    if (cur) {
      cur.revenue_usd += num(r.revenue_usd);
      cur.impressions += num(r.impressions);
      cur.source_rows++;
    } else {
      reconciled.set(key, {
        canon,
        user_id: r.user_id,
        site_id: r.site_id ?? null,
        date: r.date,
        revenue_usd: revenue,
        impressions: num(r.impressions),
        source_rows: 1,
      });
    }
  }

  // 2) pega account_id por campanha
  const campIds = Array.from(new Set([...reconciled.values()].map((v) => v.canon.campaign_id).filter((c) => c && c !== "unknown")));
  const { data: campRows } = campIds.length
    ? await admin.from("campaigns").select("campaign_id, google_account_id").eq("user_id", userId).in("campaign_id", campIds)
    : { data: [] as any[] };
  const accByCampaign = new Map<string, string | null>();
  for (const c of campRows ?? []) accByCampaign.set(String(c.campaign_id), c.google_account_id ?? null);

  // 3) upsert
  const payload = [...reconciled.values()].map((v) => ({
    user_id: v.user_id,
    site_id: v.site_id,
    google_account_id: accByCampaign.get(v.canon.campaign_id) ?? null,
    canonical_key: v.canon.canonical_key,
    campaign_id: v.canon.campaign_id,
    placement: v.canon.placement,
    normalized_placement: v.canon.normalized_placement,
    date: v.date,
    revenue_usd: v.revenue_usd,
    impressions: v.impressions,
    ecpm: v.impressions > 0 ? (v.revenue_usd / v.impressions) * 1000 : null,
    clicks: 0,
    confidence: v.canon.confidence,
    reconciliation_method: v.canon.reconciliation_method,
    broken_tracking: v.canon.broken_tracking,
    source_row: { source_rows: v.source_rows, raw_utm_placement: v.canon.raw_utm_placement },
  }));

  // upsert em batch
  const batchSize = 500;
  let upserted = 0;
  for (let i = 0; i < payload.length; i += batchSize) {
    const slice = payload.slice(i, i + batchSize);
    const { error: upErr } = await admin
      .from("placement_revenue_reconciled")
      .upsert(slice, { onConflict: "user_id,canonical_key,date" });
    if (upErr) return jerr(`upsert: ${upErr.message}`);
    upserted += slice.length;
  }

  // 4) leak check por campanha vs gam_campaign_source_revenue (PAGINADO)
  const campRev: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let cq = admin.from("gam_campaign_source_revenue")
      .select("campaign_id, revenue_usd, site_id, date")
      .eq("user_id", userId)
      .gte("date", periodStart).lte("date", periodEnd)
      .order("date", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (body.site_id) cq = cq.eq("site_id", body.site_id);
    if (body.campaign_ids?.length) cq = cq.in("campaign_id", body.campaign_ids);
    const { data: page, error: cErr } = await cq;
    if (cErr) return jerr(`camp rev: ${cErr.message}`);
    if (!page?.length) break;
    campRev.push(...page);
    if (page.length < PAGE) break;
    if (campRev.length > 500_000) break;
  }

  // ignora rows sem campaign_id (totais agregados do GAM sem dimensão de campanha — não-reconciliáveis)
  const campTotals = new Map<string, number>();
  const aggregateBySource: Record<string, number> = {};
  let aggregateOrphanRevenue = 0;
  let campaignSourceRevenue = 0;
  for (const r of campRev) {
    const rowRevenue = num(r.revenue_usd);
    const cid = r.campaign_id ? String(r.campaign_id).trim() : "";
    if (!cid || cid === "__aggregate__" || cid === "0") {
      aggregateOrphanRevenue += rowRevenue;
      const src = String((r as any).utm_source ?? "unknown").toLowerCase();
      aggregateBySource[src] = (aggregateBySource[src] ?? 0) + rowRevenue;
      continue;
    }
    campaignSourceRevenue += rowRevenue;
    campTotals.set(cid, (campTotals.get(cid) ?? 0) + rowRevenue);
  }


  const reconciledByCampaign = new Map<string, { exact: number; other: number }>();
  for (const v of reconciled.values()) {
    const cur = reconciledByCampaign.get(v.canon.campaign_id) ?? { exact: 0, other: 0 };
    if (v.canon.reconciliation_method === "exact_utm_placement") cur.exact += v.revenue_usd;
    else cur.other += v.revenue_usd;
    reconciledByCampaign.set(v.canon.campaign_id, cur);
  }

  const leakReport: any[] = [];
  for (const [cid, total] of campTotals.entries()) {
    const rec = reconciledByCampaign.get(cid) ?? { exact: 0, other: 0 };
    const all = rec.exact + rec.other;
    const leakAbs = total - all;
    const leakPct = total > 0 ? (leakAbs / total) * 100 : 0;
    const exactPct = total > 0 ? (rec.exact / total) * 100 : 0;
    let status: "verified" | "partial" | "leak_detected" | "unreliable" | "broken";
    if (brokenCount > 0 && exactPct < 50) status = "broken";
    else if (Math.abs(leakPct) <= tol && exactPct >= 95) status = "verified";
    else if (Math.abs(leakPct) <= 10) status = "partial";
    else if (Math.abs(leakPct) <= 30) status = "leak_detected";
    else status = "unreliable";
    leakReport.push({
      campaign_id: cid,
      campaign_revenue_usd: round(total),
      reconciled_revenue_usd: round(all),
      exact_revenue_usd: round(rec.exact),
      exact_share_pct: round(exactPct),
      leak_amount_usd: round(leakAbs),
      leak_percent: round(leakPct),
      status,
    });
  }

  const totalRows = (rows ?? []).length;
  const exactPctGlobal = totalRows ? ((methodCounts.exact_utm_placement ?? 0) / totalRows) * 100 : 0;
  const totalCanonicalGamRevenue = campaignSourceRevenue + aggregateOrphanRevenue;
  const totalReconciledRevenue = [...reconciledByCampaign.values()].reduce((sum, r) => sum + r.exact + r.other, 0);
  const totalLeakAmount = totalCanonicalGamRevenue - totalReconciledRevenue;
  const totalLeakPct = totalCanonicalGamRevenue > 0 ? (totalLeakAmount / totalCanonicalGamRevenue) * 100 : 0;
  const verifiedCount = leakReport.filter((r) => r.status === "verified").length;
  const campaignMatchPct = leakReport.length ? (verifiedCount / leakReport.length) * 100 : 0;
  const topUnreconciledRows = buildTopUnreconciledRows({ campRev, reconciledByCampaign, aggregateBySource, limit: 25 });
  const revenueSources = {
    gam_rows_with_placement: { rows: totalRows, revenue_usd: round(placementRevenue) },
    gam_rows_aggregated: { rows: campRev.filter((r) => !r.campaign_id || String(r.campaign_id).trim() === "__aggregate__" || String(r.campaign_id).trim() === "0").length, revenue_usd: round(aggregateOrphanRevenue), by_utm_source: roundRecord(aggregateBySource) },
    gam_rows_inferred: { rows: totalRows - (methodCounts.exact_utm_placement ?? 0), revenue_usd: round(inferredRevenue) },
    gam_rows_broken: { rows: brokenCount, revenue_usd: round(brokenRevenue) },
    gam_rows_without_utm: { revenue_usd: round(withoutUtmRevenue) },
  };

  const fullReport = {
    period: { from: periodStart, to: periodEnd },
    report_origin: {
      aggregate_root_cause: "gam_campaign_source_revenue recebe rows de KEY_VALUES_NAME somente com utm_source e sem utm_campaign/utm_placement; essas rows são salvas como campaign_id='__aggregate__'. O report gerador fica em gam-sync-revenue.collectUtmAttribution com dimensions=['DATE','KEY_VALUES_NAME'].",
      campaign_report: "gam-sync-revenue → collectUtmAttribution → KEY_VALUES_NAME → campaignRows por utm_campaign",
      placement_report: "gam-sync-revenue → collectUtmAttribution → KEY_VALUES_NAME → placementRows por utm_placement",
      likely_issue: aggregateOrphanRevenue > 0 ? "Existe revenue com utm_source, mas sem dimensões suficientes de utm_campaign/utm_placement no GAM report." : "Sem aggregate relevante no período.",
    },
    revenue_sources: revenueSources,
    reconciled_vs_total: `$${round(totalReconciledRevenue).toLocaleString("en-US")} / $${round(totalCanonicalGamRevenue).toLocaleString("en-US")}`,
    top_unreconciled_rows: topUnreconciledRows,
    raw_samples: rawSamples,
  };

  await admin.from("canonical_attribution_audit_reports").insert({
    user_id: userId,
    site_id: body.site_id ?? null,
    period_start: periodStart,
    period_end: periodEnd,
    total_gam_revenue_usd: round(totalCanonicalGamRevenue),
    reconciled_revenue_usd: round(totalReconciledRevenue),
    aggregate_revenue_usd: round(aggregateOrphanRevenue),
    leak_amount_usd: round(totalLeakAmount),
    leak_percent: round(totalLeakPct),
    campaign_match_pct: round(campaignMatchPct),
    exact_utm_placement_pct: round(exactPctGlobal),
    revenue_sources: revenueSources,
    raw_samples: rawSamples,
    top_unreconciled_rows: topUnreconciledRows,
    report: fullReport,
  });

  return jok({
    ok: true,
    period: { from: periodStart, to: periodEnd },
    source_rows: totalRows,
    reconciled_rows: upserted,
    method_breakdown: methodCounts,
    exact_utm_placement_pct: round(exactPctGlobal),
    broken_tracking_rows: brokenCount,
    aggregate_orphan_revenue_usd: round(aggregateOrphanRevenue),
    revenue_sources: revenueSources,
    reconciled_vs_total: `$${round(totalReconciledRevenue).toLocaleString("en-US")} / $${round(totalCanonicalGamRevenue).toLocaleString("en-US")}`,
    total_gam_revenue_usd: round(totalCanonicalGamRevenue),
    total_reconciled_revenue_usd: round(totalReconciledRevenue),
    global_leak_amount_usd: round(totalLeakAmount),
    global_leak_percent: round(totalLeakPct),
    campaign_match_pct: round(campaignMatchPct),
    raw_samples: rawSamples,
    top_unreconciled_rows: topUnreconciledRows,
    report_origin: fullReport.report_origin,
    leak_report: leakReport,
    summary: summarize(leakReport),

  });
});

function round(n: number) { return Math.round(n * 100) / 100; }
function summarize(rs: any[]) {
  const out: Record<string, number> = { verified: 0, partial: 0, leak_detected: 0, unreliable: 0, broken: 0 };
  for (const r of rs) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}
function jok(d: unknown) { return new Response(JSON.stringify(d), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }); }
function jerr(m: string, s = 400) { return new Response(JSON.stringify({ error: m }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: s }); }
