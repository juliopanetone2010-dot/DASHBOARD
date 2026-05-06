// ============================================================================
// ENGINE OFICIAL DE PERFORMANCE POR PAÍS (server / edge functions)
// ----------------------------------------------------------------------------
// Fórmula (idêntica à dashboard principal):
//
//   custo_pais       = campaign_country_metrics.cost  (Google Ads geo report)
//   receita_camp_dia = daily_metrics.revenue (USD bruto, mesma fonte da dash)
//   site_factor      = quando há site_id:
//                        gam_placement_revenue(site_id no período) / gam_placement_revenue(total no período)
//                      caso a campanha NÃO apareça em gam_placement_revenue → 1.0
//                      (a campanha pertence inteiramente a este site via account_site_links)
//   share_pais       = impressões_pais / impressões_camp_dia
//                      (fallback: cliques → conversões → custo)
//   receita_pais_brl = (daily_metrics.profit + daily_metrics.spend) × site_factor × share_pais × NET_FACTOR
//
//   roi_pais = (receita_pais_brl - custo_pais) / custo_pais * 100
//
// Filtros obrigatórios:
//   - user_id
//   - site_id  → derivar accounts via account_site_links
//   - account_ids (já restringidos ao site)
//   - campaign_ids (apenas campanhas que aparecem na dashboard naquele período)
//   - período [from, to]
//
// ⚠️ Mantenha em sincronia com src/lib/countryPerformance.ts (frontend).
// ============================================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

export interface CountryEngineParams {
  admin: SupabaseClient;
  userId: string;
  siteId: string | null;        // null = todos os sites
  accountIds: string[] | null;  // null = todas as contas do user (após filtro de site)
  campaignIds: string[] | null; // null = todas as campanhas (após filtro de conta)
  from: string;                 // yyyy-mm-dd
  to: string;                   // yyyy-mm-dd
  fxUsdBrl: number;
  netFactor: number;            // 1 - rev_share_pct
}

export interface CountryCell {
  campaign_id: string;
  google_account_id: string | null;
  country_code: string;
  country_name: string;
  country_criterion_id: string | null;
  cost_brl: number;             // custo real do Google Ads (já em BRL — Ads spend está em BRL)
  revenue_brl: number;          // receita líquida atribuída ao site
  revenue_gross_usd: number;    // receita bruta atribuída ao site (debug)
  clicks: number;
  impressions: number;
  conversions: number;
  share_method: "impressions" | "clicks" | "conversions" | "cost" | "none";
  share_pct: number;            // % desta linha dentro da campanha (média)
  site_factor_avg: number;      // média ponderada do site_factor aplicado
}

export interface CampaignTotals {
  campaign_id: string;
  cost_brl: number;             // soma de campaign_country_metrics.cost
  revenue_brl_net: number;      // soma de receita líquida atribuída ao site
  countries: Set<string>;
  daily_cost_brl: number;       // custo total de daily_metrics no período (sanity check)
  daily_revenue_usd: number;    // receita total bruta de daily_metrics
  site_revenue_usd: number;     // receita atribuída ao site (USD bruto)
  site_revenue_brl_gross: number; // mesma base BRL bruta usada pela dashboard
}

export interface CountryEngineResult {
  cells: Map<string, CountryCell>;        // chave: campaign_id|country_code
  campaignTotals: Map<string, CampaignTotals>;
  warnings: string[];
  meta: {
    period: { from: string; to: string };
    site_id: string | null;
    account_ids: string[] | null;
    campaign_count: number;
    rows_country_metrics: number;
    rows_daily_metrics: number;
    rows_gam_revenue: number;
  };
}

export async function computeCountryPerformance(p: CountryEngineParams): Promise<CountryEngineResult> {
  const warnings: string[] = [];

  // 1) Resolver accountIds vinculadas ao site (se houver site)
  let allowedAccountIds: string[] | null = p.accountIds ? [...p.accountIds] : null;
  if (p.siteId) {
    const { data: links, error } = await p.admin
      .from("account_site_links")
      .select("google_account_id")
      .eq("user_id", p.userId)
      .eq("site_id", p.siteId);
    if (error) throw new Error(`account_site_links: ${error.message}`);
    const siteAccs = [...new Set((links ?? []).map((l: any) => String(l.google_account_id)))];
    allowedAccountIds = allowedAccountIds
      ? allowedAccountIds.filter((id) => siteAccs.includes(id))
      : siteAccs;
  }

  // 2) Resolver campanhas (sempre filtra por account quando houver)
  let resolvedCampaignIds = p.campaignIds ? [...new Set(p.campaignIds.map(String))] : null;
  if (!resolvedCampaignIds) {
    let q = p.admin.from("campaigns").select("campaign_id").eq("user_id", p.userId);
    if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
    const { data, error } = await q.limit(10000);
    if (error) throw new Error(`campaigns: ${error.message}`);
    resolvedCampaignIds = [...new Set((data ?? []).map((r: any) => String(r.campaign_id)).filter(Boolean))];
  }

  const empty = (): CountryEngineResult => ({
    cells: new Map(), campaignTotals: new Map(), warnings,
    meta: {
      period: { from: p.from, to: p.to }, site_id: p.siteId,
      account_ids: allowedAccountIds, campaign_count: 0,
      rows_country_metrics: 0, rows_daily_metrics: 0, rows_gam_revenue: 0,
    },
  });
  if (!resolvedCampaignIds || resolvedCampaignIds.length === 0) return empty();

  // 3) campaign_country_metrics — custo/cliques/impressões por (camp,date,país)
  type CRow = {
    campaign_id: string; date: string; country_code: string; country_name: string | null;
    country_criterion_id: string | null; google_account_id: string | null;
    cost: number; clicks: number; impressions: number; conversions: number;
  };
  const countryRows: CRow[] = [];
  for (const chunk of chunk200(resolvedCampaignIds)) {
    let start = 0;
    for (;;) {
      let q = p.admin.from("campaign_country_metrics")
        .select("campaign_id, date, country_code, country_name, country_criterion_id, google_account_id, cost, clicks, impressions, conversions")
        .eq("user_id", p.userId)
        .in("campaign_id", chunk)
        .gte("date", p.from).lte("date", p.to);
      if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
      const { data, error } = await q.range(start, start + 999);
      if (error) throw new Error(`campaign_country_metrics: ${error.message}`);
      const rows = (data ?? []) as CRow[];
      countryRows.push(...rows);
      if (rows.length < 1000) break;
      start += 1000;
    }
  }

  // 4) daily_metrics — mesma base da dashboard: spend/profit em BRL + revenue em USD debug
  type DRow = { campaign_id: string; date: string; spend: number; revenue: number; profit: number };
  const dailyRows: DRow[] = [];
  for (const chunk of chunk200(resolvedCampaignIds)) {
    let start = 0;
    for (;;) {
      let q = p.admin.from("daily_metrics")
        .select("campaign_id, date, spend, revenue, profit")
        .eq("user_id", p.userId)
        .in("campaign_id", chunk)
        .gte("date", p.from).lte("date", p.to);
      if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
      const { data, error } = await q.range(start, start + 999);
      if (error) throw new Error(`daily_metrics: ${error.message}`);
      const rows = (data ?? []) as DRow[];
      dailyRows.push(...rows);
      if (rows.length < 1000) break;
      start += 1000;
    }
  }

  // 5) gam_placement_revenue — para calcular site_factor por (camp,date)
  // siteFactor = receita_atribuida_site / receita_total_camp_dia
  // Se a campanha não aparece em gam_placement_revenue, assume-se 1.0 (single-site)
  type GRow = { campaign_id: string; date: string; site_id: string | null; revenue_usd: number };
  const gamRows: GRow[] = [];
  for (const chunk of chunk200(resolvedCampaignIds)) {
    let start = 0;
    for (;;) {
      const { data, error } = await p.admin.from("gam_placement_revenue")
        .select("campaign_id, date, site_id, revenue_usd")
        .eq("user_id", p.userId)
        .in("campaign_id", chunk)
        .neq("campaign_id", "__aggregate__")
        .gte("date", p.from).lte("date", p.to)
        .range(start, start + 999);
      if (error) throw new Error(`gam_placement_revenue: ${error.message}`);
      const rows = (data ?? []) as GRow[];
      gamRows.push(...rows);
      if (rows.length < 1000) break;
      start += 1000;
    }
  }

  // 6) Indexes
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

  // gamTotalByCD = soma de gam_placement_revenue por (camp,date) com site_id != null
  // gamSiteByCD  = soma para site_id selecionado
  // campaignsInGam = campanhas que aparecem em gam_placement_revenue (any site)
  const gamTotalByCD = new Map<string, number>();
  const gamSiteByCD = new Map<string, number>();
  const campaignsInGam = new Set<string>();
  for (const r of gamRows) {
    if (!r.site_id) continue;
    campaignsInGam.add(String(r.campaign_id));
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

  // siteFactor(camp,date):
  //   - sem site_id: 1.0 (todos os sites)
  //   - com site_id e camp não está em gam_placement_revenue: 1.0 (assume single-site da conta)
  //   - com site_id e camp está em gam: site/total (0..1)
  const siteFactor = (campaignId: string, date: string): number => {
    if (!p.siteId) return 1;
    if (!campaignsInGam.has(campaignId)) return 1;
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

  // Totais por (camp,date) para o cálculo do share país
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

  // 7) Construção das células
  const cells = new Map<string, CountryCell>();
  // acumuladores para ponderar share_pct e site_factor médios
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
    if (!totals || !daily || daily.revenue <= 0) continue;

    let share = 0;
    let method: CountryCell["share_method"] = "none";
    if (totals.impr > 0)        { share = impr   / totals.impr;   method = "impressions"; }
    else if (totals.clicks > 0) { share = clicks / totals.clicks; method = "clicks"; }
    else if (totals.conv > 0)   { share = conv   / totals.conv;   method = "conversions"; }
    else if (totals.cost > 0)   { share = cost   / totals.cost;   method = "cost"; }
    if (share <= 0) continue;

    const sf = siteFactor(r.campaign_id, r.date);
    if (sf <= 0) continue;

    const grossUsd = daily.revenue * sf * share;
    cell.revenue_gross_usd += grossUsd;
    cell.revenue_brl += grossUsd * p.netFactor * p.fxUsdBrl;
    if (cell.share_method === "none") cell.share_method = method;

    acc.shareSum += share; acc.shareCount += 1;
    acc.sfTotal += sf * share; acc.sfWeight += share;
  }

  for (const [k, cell] of cells) {
    const acc = cellAccum.get(k)!;
    cell.share_pct = acc.shareCount > 0 ? (acc.shareSum / acc.shareCount) * 100 : 0;
    cell.site_factor_avg = acc.sfWeight > 0 ? acc.sfTotal / acc.sfWeight : (p.siteId ? 0 : 1);
  }

  // 8) Totais por campanha (sanity check)
  const campaignTotals = new Map<string, CampaignTotals>();
  for (const cell of cells.values()) {
    let t = campaignTotals.get(cell.campaign_id);
    if (!t) {
      t = {
        campaign_id: cell.campaign_id,
        cost_brl: 0, revenue_brl_net: 0, countries: new Set(),
        daily_cost_brl: 0, daily_revenue_usd: 0, site_revenue_usd: 0,
      };
      campaignTotals.set(cell.campaign_id, t);
    }
    t.cost_brl += cell.cost_brl;
    t.revenue_brl_net += cell.revenue_brl;
    if (cell.country_code) t.countries.add(cell.country_code);
  }
  // anexa daily totals + site revenue por campanha
  for (const [k, v] of dailyByCD) {
    const [campaign_id] = k.split("|");
    const t = campaignTotals.get(campaign_id);
    if (!t) continue;
    t.daily_cost_brl += v.spend;
    t.daily_revenue_usd += v.revenue;
    const sf = siteFactor(campaign_id, k.split("|")[1]);
    t.site_revenue_usd += v.revenue * sf;
  }

  // 9) Warnings de consistência
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
      rows_country_metrics: countryRows.length,
      rows_daily_metrics: dailyRows.length,
      rows_gam_revenue: gamRows.length,
    },
  };
}

function chunk200<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 200) out.push(arr.slice(i, i + 200));
  return out;
}
