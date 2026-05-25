// rebuild-canonical-placement-engine
// ============================================================================
// Reconstrói a tabela `placement_revenue_reconciled` usando utm_placement como
// SOURCE OF TRUTH + executa o aggregate_distribution_engine para alocar revenue
// agregada (rows do GAM sem campaign_id/utm_placement) proporcionalmente aos
// placements reconciliados.
//
// Etapas:
//   1) puxa rows do GAM (gam_placement_revenue) no período
//   2) extrai utm_placement, reconcilia (canonical_key)
//   3) consolida por (canonical_key, date) preservando utm_source breakdown
//   4) upsert em placement_revenue_reconciled
//   5) AGGREGATE DISTRIBUTION: pega gam_campaign_source_revenue com
//      campaign_id IN (__aggregate__, 0, vazio) e distribui revenue
//      proporcional por (site_id, date, utm_source) usando impressions
//      como peso (fallback: revenue_usd reconciliado).
//   6) update placement_revenue_reconciled com aggregate_allocated_revenue_usd
//      e allocation_status = 'verified' | 'verified_allocated'
//   7) calcula leak vs gam_campaign_source_revenue
//   8) retorna sumário + aggregate breakdown completo (por site/source/campanha)
//
// IMPORTANTE: placement cleanup AINDA usa somente reconciliation_method =
// 'exact_utm_placement'. allocation_status='verified_allocated' NÃO autoriza
// exclusão — é apenas para reduzir leak no audit.
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
  allocation_method?: "impressions" | "reconciled_revenue" | "clicks";
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const normSource = (s: unknown) => String(s ?? "unknown").trim().toLowerCase() || "unknown";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SR);

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty */ }

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
  const allocationMethod = body.allocation_method ?? "impressions";

  // ---------------------------------------------------------------------------
  // 1) puxa rows de gam_placement_revenue (PAGINADO)
  // ---------------------------------------------------------------------------
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
    if (rows.length > 500_000) break;
  }

  // ---------------------------------------------------------------------------
  // 2-3) reconcilia + consolida (canonical_key|date) preservando utm_source
  // ---------------------------------------------------------------------------
  interface ReconciledEntry {
    canon: CanonicalPlacement;
    user_id: string;
    site_id: string | null;
    date: string;
    revenue_usd: number;
    impressions: number;
    source_rows: number;
    // Para distribuição: peso por utm_source dentro deste bucket
    by_source: Map<string, { revenue: number; impressions: number }>;
  }
  const reconciled = new Map<string, ReconciledEntry>();

  let brokenCount = 0;
  let placementRevenue = 0;
  let exactRevenue = 0;
  let inferredRevenue = 0;
  let brokenRevenue = 0;
  let withoutUtmRevenue = 0;
  let campaignIdMismatchRows = 0;
  let campaignIdMismatchRevenue = 0;
  const rawSamples: any[] = [];
  const methodCounts: Record<string, number> = {};

  for (const r of rows ?? []) {
    const revenue = num(r.revenue_usd);
    const impressions = num(r.impressions);
    const src = normSource(r.utm_source);
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
    if (String(canon.campaign_id) !== String(r.campaign_id)) {
      campaignIdMismatchRows++;
      campaignIdMismatchRevenue += revenue;
    }
    if (rawSamples.length < 25) {
      rawSamples.push({
        source_table: "gam_placement_revenue",
        raw_gam_row: r,
        raw_utm_placement: rawUtmPlacement,
        raw_url: null,
        raw_placement: r.placement ?? null,
        dimensions: { date: r.date, campaign_id: r.campaign_id, placement: r.placement, site_id: r.site_id, utm_source: r.utm_source },
        parser_result: canon,
        campaign_id_mismatch: String(canon.campaign_id) !== String(r.campaign_id),
      });
    }

    const key = `${canon.canonical_key}|${r.date}`;
    let cur = reconciled.get(key);
    if (!cur) {
      cur = {
        canon,
        user_id: r.user_id,
        site_id: r.site_id ?? null,
        date: r.date,
        revenue_usd: 0,
        impressions: 0,
        source_rows: 0,
        by_source: new Map(),
      };
      reconciled.set(key, cur);
    }
    cur.revenue_usd += revenue;
    cur.impressions += impressions;
    cur.source_rows++;
    const sb = cur.by_source.get(src) ?? { revenue: 0, impressions: 0 };
    sb.revenue += revenue;
    sb.impressions += impressions;
    cur.by_source.set(src, sb);
  }

  // ---------------------------------------------------------------------------
  // 4) account_id por campanha
  // ---------------------------------------------------------------------------
  const campIds = Array.from(new Set([...reconciled.values()].map((v) => v.canon.campaign_id).filter((c) => c && c !== "unknown")));
  const { data: campRows } = campIds.length
    ? await admin.from("campaigns").select("campaign_id, google_account_id").eq("user_id", userId).in("campaign_id", campIds)
    : { data: [] as any[] };
  const accByCampaign = new Map<string, string | null>();
  for (const c of campRows ?? []) accByCampaign.set(String(c.campaign_id), c.google_account_id ?? null);

  // ---------------------------------------------------------------------------
  // 5) puxa gam_campaign_source_revenue (PAGINADO) — usado para leak + aggregate
  // ---------------------------------------------------------------------------
  const campRev: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let cq = admin.from("gam_campaign_source_revenue")
      .select("campaign_id, revenue_usd, site_id, date, utm_source, impressions")
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

  const isAggregateRow = (cid: unknown) => {
    const s = cid ? String(cid).trim() : "";
    return !s || s === "__aggregate__" || s === "0";
  };

  // ---------------------------------------------------------------------------
  // 6) AGGREGATE DISTRIBUTION ENGINE
  // Agrupa revenue agregada por (site_id|date|utm_source) e distribui para
  // os reconciled entries que casam nesse mesmo bucket.
  // ---------------------------------------------------------------------------
  // bucket key: `${site_id ?? '*'}|${date}|${utm_source}`
  const aggregateBuckets = new Map<string, { site_id: string | null; date: string; utm_source: string; revenue: number; row_count: number }>();
  let aggregateOrphanRevenue = 0;
  let campaignSourceRevenue = 0;
  const campTotals = new Map<string, number>();
  const aggregateBySource: Record<string, number> = {};
  const aggregateBySite: Record<string, number> = {};

  for (const r of campRev) {
    const revenue = num(r.revenue_usd);
    if (isAggregateRow(r.campaign_id)) {
      aggregateOrphanRevenue += revenue;
      const src = normSource(r.utm_source);
      aggregateBySource[src] = (aggregateBySource[src] ?? 0) + revenue;
      const siteKey = r.site_id ?? "__no_site__";
      aggregateBySite[siteKey] = (aggregateBySite[siteKey] ?? 0) + revenue;
      const bk = `${r.site_id ?? "*"}|${r.date}|${src}`;
      const cur = aggregateBuckets.get(bk) ?? { site_id: r.site_id ?? null, date: r.date, utm_source: src, revenue: 0, row_count: 0 };
      cur.revenue += revenue;
      cur.row_count++;
      aggregateBuckets.set(bk, cur);
      continue;
    }
    campaignSourceRevenue += revenue;
    const cid = String(r.campaign_id).trim();
    campTotals.set(cid, (campTotals.get(cid) ?? 0) + revenue);
  }

  // Index reconciled entries por (site_id, date, utm_source) → entries[]
  const recIndex = new Map<string, ReconciledEntry[]>();
  for (const entry of reconciled.values()) {
    for (const src of entry.by_source.keys()) {
      const k = `${entry.site_id ?? "*"}|${entry.date}|${src}`;
      const arr = recIndex.get(k) ?? [];
      arr.push(entry);
      recIndex.set(k, arr);
    }
  }

  // allocate
  const allocatedByEntry = new Map<ReconciledEntry, number>();
  const distributionDebug: Array<{ bucket: string; revenue: number; allocated_to_entries: number; method: string; matched: boolean }> = [];
  let allocatedTotal = 0;
  let unresolvedAggregate = 0;

  for (const [bk, bucket] of aggregateBuckets.entries()) {
    const candidates = recIndex.get(bk) ?? [];
    if (!candidates.length) {
      unresolvedAggregate += bucket.revenue;
      if (distributionDebug.length < 50) {
        distributionDebug.push({ bucket: bk, revenue: round(bucket.revenue), allocated_to_entries: 0, method: allocationMethod, matched: false });
      }
      continue;
    }
    // calcula pesos
    const weights: number[] = candidates.map((c) => {
      const sb = c.by_source.get(bucket.utm_source) ?? { revenue: 0, impressions: 0 };
      if (allocationMethod === "reconciled_revenue") return sb.revenue;
      return sb.impressions; // default / clicks fallback (não temos clicks no GAM)
    });
    let weightSum = weights.reduce((a, b) => a + b, 0);
    // fallback: se todos pesos zero, distribui igualmente
    if (weightSum <= 0) {
      for (let i = 0; i < candidates.length; i++) weights[i] = 1;
      weightSum = weights.length;
    }
    for (let i = 0; i < candidates.length; i++) {
      const share = (weights[i] / weightSum) * bucket.revenue;
      allocatedByEntry.set(candidates[i], (allocatedByEntry.get(candidates[i]) ?? 0) + share);
    }
    allocatedTotal += bucket.revenue;
    if (distributionDebug.length < 50) {
      distributionDebug.push({ bucket: bk, revenue: round(bucket.revenue), allocated_to_entries: candidates.length, method: allocationMethod, matched: true });
    }
  }

  // ---------------------------------------------------------------------------
  // 7) Monta payload com allocation + upsert
  // ---------------------------------------------------------------------------
  const payload = [...reconciled.values()].map((v) => {
    const allocated = allocatedByEntry.get(v) ?? 0;
    const allocationStatus = allocated > 0 ? "verified_allocated" : "verified";
    return {
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
      source_row: { source_rows: v.source_rows, raw_utm_placement: v.canon.raw_utm_placement, by_source: Object.fromEntries([...v.by_source.entries()].map(([k, val]) => [k, { revenue: round(val.revenue), impressions: val.impressions }])) },
      aggregate_allocated_revenue_usd: round(allocated),
      allocation_status: allocationStatus,
      allocation_method: allocated > 0 ? allocationMethod : null,
    };
  });

  let delQ = admin.from("placement_revenue_reconciled")
    .delete()
    .eq("user_id", userId)
    .gte("date", periodStart)
    .lte("date", periodEnd);
  if (body.site_id) delQ = delQ.eq("site_id", body.site_id);
  if (body.campaign_ids?.length) delQ = delQ.in("campaign_id", body.campaign_ids);
  const { error: delErr } = await delQ;
  if (delErr) return jerr(`clear canonical period: ${delErr.message}`);

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

  // ---------------------------------------------------------------------------
  // 8) Leak report por campanha (somando allocated)
  // ---------------------------------------------------------------------------
  const reconciledByCampaign = new Map<string, { exact: number; other: number; allocated: number }>();
  for (const v of reconciled.values()) {
    const cur = reconciledByCampaign.get(v.canon.campaign_id) ?? { exact: 0, other: 0, allocated: 0 };
    if (v.canon.reconciliation_method === "exact_utm_placement") cur.exact += v.revenue_usd;
    else cur.other += v.revenue_usd;
    cur.allocated += allocatedByEntry.get(v) ?? 0;
    reconciledByCampaign.set(v.canon.campaign_id, cur);
  }

  const leakReport: any[] = [];
  for (const [cid, total] of campTotals.entries()) {
    const rec = reconciledByCampaign.get(cid) ?? { exact: 0, other: 0, allocated: 0 };
    const all = rec.exact + rec.other + rec.allocated;
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
      allocated_revenue_usd: round(rec.allocated),
      exact_share_pct: round(exactPct),
      leak_amount_usd: round(leakAbs),
      leak_percent: round(leakPct),
      status,
    });
  }

  const totalRows = (rows ?? []).length;
  const exactPctGlobal = totalRows ? ((methodCounts.exact_utm_placement ?? 0) / totalRows) * 100 : 0;
  const totalCanonicalGamRevenue = campaignSourceRevenue + aggregateOrphanRevenue;
  const totalReconciledRevenue = [...reconciledByCampaign.values()].reduce((sum, r) => sum + r.exact + r.other + r.allocated, 0);
  const totalLeakAmount = totalCanonicalGamRevenue - totalReconciledRevenue;
  const totalLeakPct = totalCanonicalGamRevenue > 0 ? (totalLeakAmount / totalCanonicalGamRevenue) * 100 : 0;
  const verifiedCount = leakReport.filter((r) => r.status === "verified").length;
  const campaignMatchPct = leakReport.length ? (verifiedCount / leakReport.length) * 100 : 0;
  const topUnreconciledRows = buildTopUnreconciledRows({ campRev, reconciledByCampaign, limit: 25 });

  const aggregateDistribution = {
    total_aggregate_revenue_usd: round(aggregateOrphanRevenue),
    allocated_revenue_usd: round(allocatedTotal),
    unresolved_revenue_usd: round(unresolvedAggregate),
    allocation_method: allocationMethod,
    buckets_total: aggregateBuckets.size,
    buckets_matched: distributionDebug.filter((d) => d.matched).length,
    buckets_unmatched: distributionDebug.filter((d) => !d.matched).length,
    by_utm_source: roundRecord(aggregateBySource),
    by_site: roundRecord(aggregateBySite),
    sample_buckets: distributionDebug.slice(0, 25),
  };

  const revenueSources = {
    gam_rows_with_placement: { rows: totalRows, revenue_usd: round(placementRevenue) },
    gam_rows_aggregated: { rows: campRev.filter((r) => isAggregateRow(r.campaign_id)).length, revenue_usd: round(aggregateOrphanRevenue), by_utm_source: roundRecord(aggregateBySource) },
    gam_rows_inferred: { rows: totalRows - (methodCounts.exact_utm_placement ?? 0), revenue_usd: round(inferredRevenue) },
    gam_rows_broken: { rows: brokenCount, revenue_usd: round(brokenRevenue) },
    gam_rows_without_utm: { revenue_usd: round(withoutUtmRevenue) },
    campaign_id_mismatch: { rows: campaignIdMismatchRows, revenue_usd: round(campaignIdMismatchRevenue), explanation: "utm_placement campaignid diverge da coluna campaign_id em gam_placement_revenue" },
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
    aggregate_distribution: aggregateDistribution,
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
    aggregate_allocated_revenue_usd: round(allocatedTotal),
    aggregate_unresolved_revenue_usd: round(unresolvedAggregate),
    aggregate_distribution: aggregateDistribution,
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
    aggregate_allocated_revenue_usd: round(allocatedTotal),
    aggregate_unresolved_revenue_usd: round(unresolvedAggregate),
    aggregate_distribution: aggregateDistribution,
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
function roundRecord(input: Record<string, number>) {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, round(v)]));
}
function buildTopUnreconciledRows(args: {
  campRev: any[];
  reconciledByCampaign: Map<string, { exact: number; other: number; allocated: number }>;
  limit: number;
}) {
  const out: any[] = [];
  const byCampaign = new Map<string, { revenue: number; rows: any[] }>();
  for (const r of args.campRev) {
    const cid = r.campaign_id ? String(r.campaign_id).trim() : "";
    const revenue = num(r.revenue_usd);
    if (!cid || cid === "__aggregate__" || cid === "0") {
      out.push({
        source_table: "gam_campaign_source_revenue",
        raw_gam_row: r,
        dimensions: { date: r.date, campaign_id: r.campaign_id, site_id: r.site_id, utm_source: (r as any).utm_source ?? null },
        revenue_usd: round(revenue),
        why_not_matched: "aggregate_without_campaign_or_utm_placement",
        report_query: "gam-sync-revenue KEY_VALUES_NAME row had utm_source but no utm_campaign/utm_placement",
      });
      continue;
    }
    const cur = byCampaign.get(cid) ?? { revenue: 0, rows: [] };
    cur.revenue += revenue;
    if (cur.rows.length < 5) cur.rows.push(r);
    byCampaign.set(cid, cur);
  }
  for (const [cid, v] of byCampaign) {
    const rec = args.reconciledByCampaign.get(cid) ?? { exact: 0, other: 0, allocated: 0 };
    const matched = rec.exact + rec.other + rec.allocated;
    const diff = v.revenue - matched;
    if (Math.abs(diff) < 0.01) continue;
    out.push({
      source_table: "gam_campaign_source_revenue",
      raw_gam_row: v.rows[0] ?? { campaign_id: cid },
      dimensions: { campaign_id: cid, sample_dates: v.rows.map((r) => r.date), rows_sampled: v.rows.length },
      revenue_usd: round(v.revenue),
      reconciled_revenue_usd: round(matched),
      unreconciled_usd: round(diff),
      why_not_matched: diff > 0 ? "campaign_revenue_without_matching_placement_revenue" : "placement_revenue_exceeds_campaign_source_revenue",
      report_query: "Compare gam_campaign_source_revenue(utm_campaign) vs gam_placement_revenue(utm_placement)",
    });
  }
  return out
    .sort((a, b) => Math.abs(num(b.unreconciled_usd ?? b.revenue_usd)) - Math.abs(num(a.unreconciled_usd ?? a.revenue_usd)))
    .slice(0, args.limit);
}

function jok(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function jerr(message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
