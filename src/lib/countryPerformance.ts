// ============================================================================
// ENGINE OFICIAL DE PERFORMANCE POR PAÍS (cliente)
// Espelho exato de supabase/functions/_shared/country_performance.ts.
// Mantenha em sincronia. Veja o cabeçalho daquele arquivo para a fórmula.
// ============================================================================
import { supabase } from "@/integrations/supabase/client";

export interface ClientCountryEngineParams {
  siteId: string | null;
  accountIds: string[] | null;
  campaignIds: string[] | null;
  from: string;
  to: string;
  fxUsdBrl: number;
  netFactor: number;
}

export interface ClientCountryCell {
  campaign_id: string;
  google_account_id: string | null;
  country_code: string;
  country_name: string;
  country_criterion_id: string | null;
  cost_brl: number;
  revenue_brl: number;
  revenue_gross_usd: number;
  clicks: number;
  impressions: number;
  conversions: number;
  share_method: "impressions" | "clicks" | "conversions" | "cost" | "none";
  share_pct: number;
  site_factor_avg: number;
}

export interface ClientCampaignTotals {
  campaign_id: string;
  cost_brl: number;
  revenue_brl_net: number;
  countries: Set<string>;
  daily_cost_brl: number;
  daily_revenue_usd: number;
  site_revenue_usd: number;
  site_revenue_brl_gross: number;
}

export interface ClientCountryEngineResult {
  cells: Map<string, ClientCountryCell>;
  campaignTotals: Map<string, ClientCampaignTotals>;
  warnings: string[];
  meta: {
    period: { from: string; to: string };
    site_id: string | null;
    account_ids: string[] | null;
    campaign_count: number;
  };
}

export async function computeCountryPerformanceClient(
  p: ClientCountryEngineParams,
): Promise<ClientCountryEngineResult> {
  const warnings: string[] = [];

  // 1) accounts vinculadas ao site
  let allowedAccountIds: string[] | null = p.accountIds ? [...p.accountIds] : null;
  if (p.siteId) {
    const { data: links } = await supabase
      .from("account_site_links")
      .select("google_account_id")
      .eq("site_id", p.siteId);
    const siteAccs = [...new Set((links ?? []).map((l: any) => String(l.google_account_id)))];
    allowedAccountIds = allowedAccountIds
      ? allowedAccountIds.filter((id) => siteAccs.includes(id))
      : siteAccs;
  }

  // 2) campanhas
  let resolvedCampaignIds = p.campaignIds ? [...new Set(p.campaignIds.map(String))] : null;
  if (!resolvedCampaignIds) {
    let q = supabase.from("campaigns").select("campaign_id");
    if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
    const { data } = await q.limit(10000);
    resolvedCampaignIds = [...new Set((data ?? []).map((r: any) => String(r.campaign_id)).filter(Boolean))];
  }

  const empty = (): ClientCountryEngineResult => ({
    cells: new Map(), campaignTotals: new Map(), warnings,
    meta: { period: { from: p.from, to: p.to }, site_id: p.siteId, account_ids: allowedAccountIds, campaign_count: 0 },
  });
  if (!resolvedCampaignIds || resolvedCampaignIds.length === 0) return empty();

  type CRow = {
    campaign_id: string; date: string; country_code: string; country_name: string | null;
    country_criterion_id: string | null; google_account_id: string | null;
    cost: number; clicks: number; impressions: number; conversions: number;
  };
  const countryRows: CRow[] = [];
  for (const chunk of chunk200(resolvedCampaignIds)) {
    let start = 0;
    for (;;) {
      let q = supabase.from("campaign_country_metrics")
        .select("campaign_id, date, country_code, country_name, country_criterion_id, google_account_id, cost, clicks, impressions, conversions")
        .in("campaign_id", chunk)
        .gte("date", p.from).lte("date", p.to);
      if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
      const { data, error } = await q.range(start, start + 999);
      if (error) break;
      const rows = (data ?? []) as CRow[];
      countryRows.push(...rows);
      if (rows.length < 1000) break;
      start += 1000;
    }
  }

  type DRow = { campaign_id: string; date: string; spend: number; revenue: number; profit: number };
  const dailyRows: DRow[] = [];
  for (const chunk of chunk200(resolvedCampaignIds)) {
    let start = 0;
    for (;;) {
      let q = supabase.from("daily_metrics")
        .select("campaign_id, date, spend, revenue, profit")
        .in("campaign_id", chunk)
        .gte("date", p.from).lte("date", p.to);
      if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
      const { data, error } = await q.range(start, start + 999);
      if (error) break;
      const rows = (data ?? []) as DRow[];
      dailyRows.push(...rows);
      if (rows.length < 1000) break;
      start += 1000;
    }
  }

  type GRow = { campaign_id: string; date: string; site_id: string | null; revenue_usd: number };
  const gamRows: GRow[] = [];
  for (const chunk of chunk200(resolvedCampaignIds)) {
    let start = 0;
    for (;;) {
      const { data, error } = await supabase.from("gam_placement_revenue")
        .select("campaign_id, date, site_id, revenue_usd")
        .in("campaign_id", chunk)
        .neq("campaign_id", "__aggregate__")
        .gte("date", p.from).lte("date", p.to)
        .range(start, start + 999);
      if (error) break;
      const rows = (data ?? []) as GRow[];
      gamRows.push(...rows);
      if (rows.length < 1000) break;
      start += 1000;
    }
  }

  const dailyByCD = new Map<string, { spend: number; revenue: number; profit: number; grossRevenueBrl: number }>();
  for (const r of dailyRows) {
    const k = `${r.campaign_id}|${r.date}`;
    const acc = dailyByCD.get(k) ?? { spend: 0, revenue: 0, profit: 0, grossRevenueBrl: 0 };
    acc.spend += Number(r.spend) || 0;
    acc.revenue += Number(r.revenue) || 0;
    acc.profit += Number(r.profit) || 0;
    acc.grossRevenueBrl += (Number(r.profit) || 0) + (Number(r.spend) || 0);
    dailyByCD.set(k, acc);
  }

  const gamTotalByCD = new Map<string, number>();
  const gamSiteByCD = new Map<string, number>();
  const campaignsInGam = new Set<string>();
  const gamSitesByCampaign = new Map<string, Set<string>>();
  for (const r of gamRows) {
    if (!r.site_id) continue;
    const campaignId = String(r.campaign_id);
    campaignsInGam.add(campaignId);
    const sites = gamSitesByCampaign.get(campaignId) ?? new Set<string>();
    sites.add(String(r.site_id));
    gamSitesByCampaign.set(campaignId, sites);
    const k = `${r.campaign_id}|${r.date}`;
    const v = Number(r.revenue_usd) || 0;
    gamTotalByCD.set(k, (gamTotalByCD.get(k) ?? 0) + v);
    if (p.siteId && String(r.site_id) === p.siteId) {
      gamSiteByCD.set(k, (gamSiteByCD.get(k) ?? 0) + v);
    }
  }

  const gamTotalByCampaign = new Map<string, number>();
  const gamSiteByCampaign = new Map<string, number>();
  for (const [k, total] of gamTotalByCD) {
    const [campaignId] = k.split("|");
    gamTotalByCampaign.set(campaignId, (gamTotalByCampaign.get(campaignId) ?? 0) + total);
  }
  for (const [k, site] of gamSiteByCD) {
    const [campaignId] = k.split("|");
    gamSiteByCampaign.set(campaignId, (gamSiteByCampaign.get(campaignId) ?? 0) + site);
  }

  const siteFactor = (campaignId: string, date: string): number => {
    if (!p.siteId) return 1;
    if (!campaignsInGam.has(campaignId)) return 1;
    if ((gamSitesByCampaign.get(campaignId)?.size ?? 0) <= 1) return 1;
    const periodTotal = gamTotalByCampaign.get(campaignId) ?? 0;
    if (periodTotal > 0) {
      const periodSite = gamSiteByCampaign.get(campaignId) ?? 0;
      return Math.min(1, Math.max(0, periodSite / periodTotal));
    }
    const k = `${campaignId}|${date}`;
    const total = gamTotalByCD.get(k) ?? 0;
    if (total <= 0) return 0;
    const site = gamSiteByCD.get(k) ?? 0;
    return Math.min(1, Math.max(0, site / total));
  };

  const totalsByCD = new Map<string, { impr: number; clicks: number; conv: number; cost: number }>();
  for (const r of countryRows) {
    const k = `${r.campaign_id}|${r.date}`;
    const acc = totalsByCD.get(k) ?? { impr: 0, clicks: 0, conv: 0, cost: 0 };
    acc.impr += Number(r.impressions) || 0;
    acc.clicks += Number(r.clicks) || 0;
    acc.conv += Number(r.conversions) || 0;
    acc.cost += Number(r.cost) || 0;
    totalsByCD.set(k, acc);
  }

  const cells = new Map<string, ClientCountryCell>();
  const cellAccum = new Map<string, { shareSum: number; shareCount: number; sfWeight: number; sfTotal: number }>();

  for (const r of countryRows) {
    const k = `${r.campaign_id}|${r.country_code}`;
    let cell = cells.get(k);
    if (!cell) {
      cell = {
        campaign_id: r.campaign_id,
        google_account_id: r.google_account_id,
        country_code: r.country_code,
        country_name: r.country_name ?? r.country_code,
        country_criterion_id: r.country_criterion_id,
        cost_brl: 0, revenue_brl: 0, revenue_gross_usd: 0,
        clicks: 0, impressions: 0, conversions: 0,
        share_method: "none", share_pct: 0, site_factor_avg: 0,
      };
      cells.set(k, cell);
      cellAccum.set(k, { shareSum: 0, shareCount: 0, sfWeight: 0, sfTotal: 0 });
    }
    const acc = cellAccum.get(k)!;

    const cost = Number(r.cost) || 0;
    const clicks = Number(r.clicks) || 0;
    const impr = Number(r.impressions) || 0;
    const conv = Number(r.conversions) || 0;

    cell.cost_brl += cost;
    cell.clicks += clicks;
    cell.impressions += impr;
    cell.conversions += conv;
    if (!cell.country_criterion_id && r.country_criterion_id) cell.country_criterion_id = r.country_criterion_id;
    if (!cell.google_account_id && r.google_account_id) cell.google_account_id = r.google_account_id;

    const cd = `${r.campaign_id}|${r.date}`;
    const totals = totalsByCD.get(cd);
    const daily = dailyByCD.get(cd);
    if (!totals || !daily || daily.grossRevenueBrl <= 0) continue;

    let share = 0;
    let method: ClientCountryCell["share_method"] = "none";
    if (totals.impr > 0)        { share = impr   / totals.impr;   method = "impressions"; }
    else if (totals.clicks > 0) { share = clicks / totals.clicks; method = "clicks"; }
    else if (totals.conv > 0)   { share = conv   / totals.conv;   method = "conversions"; }
    else if (totals.cost > 0)   { share = cost   / totals.cost;   method = "cost"; }
    if (share <= 0) continue;

    const sf = siteFactor(r.campaign_id, r.date);
    if (sf <= 0) continue;

    const grossUsd = daily.revenue * sf * share;
    const grossBrl = daily.grossRevenueBrl * sf * share;
    cell.revenue_gross_usd += grossUsd;
    cell.revenue_brl += grossBrl * p.netFactor;
    if (cell.share_method === "none") cell.share_method = method;

    acc.shareSum += share; acc.shareCount += 1;
    acc.sfTotal += sf * share; acc.sfWeight += share;
  }

  for (const [k, cell] of cells) {
    const acc = cellAccum.get(k)!;
    cell.share_pct = acc.shareCount > 0 ? (acc.shareSum / acc.shareCount) * 100 : 0;
    cell.site_factor_avg = acc.sfWeight > 0 ? acc.sfTotal / acc.sfWeight : (p.siteId ? 0 : 1);
  }

  const campaignTotals = new Map<string, ClientCampaignTotals>();
  for (const cell of cells.values()) {
    let t = campaignTotals.get(cell.campaign_id);
    if (!t) {
      t = {
        campaign_id: cell.campaign_id,
        cost_brl: 0, revenue_brl_net: 0, countries: new Set(),
        daily_cost_brl: 0, daily_revenue_usd: 0, site_revenue_usd: 0, site_revenue_brl_gross: 0,
      };
      campaignTotals.set(cell.campaign_id, t);
    }
    t.cost_brl += cell.cost_brl;
    t.revenue_brl_net += cell.revenue_brl;
    if (cell.country_code) t.countries.add(cell.country_code);
  }
  for (const [k, v] of dailyByCD) {
    const [campaign_id, date] = k.split("|");
    const t = campaignTotals.get(campaign_id);
    if (!t) continue;
    t.daily_cost_brl += v.spend;
    t.daily_revenue_usd += v.revenue;
    const sf = siteFactor(campaign_id, date);
    t.site_revenue_usd += v.revenue * sf;
    t.site_revenue_brl_gross += v.grossRevenueBrl * sf;
  }

  for (const t of campaignTotals.values()) {
    if (t.daily_cost_brl > 0 && Math.abs(t.cost_brl - t.daily_cost_brl) / t.daily_cost_brl > 0.10) {
      warnings.push(`campaign ${t.campaign_id}: custo país (R$${t.cost_brl.toFixed(2)}) difere de daily_metrics (R$${t.daily_cost_brl.toFixed(2)}) em mais de 10%`);
    }
  }

  return {
    cells, campaignTotals, warnings,
    meta: {
      period: { from: p.from, to: p.to }, site_id: p.siteId,
      account_ids: allowedAccountIds, campaign_count: resolvedCampaignIds.length,
    },
  };
}

function chunk200<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 200) out.push(arr.slice(i, i + 200));
  return out;
}
