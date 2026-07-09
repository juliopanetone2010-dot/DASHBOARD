// ============================================================================
// ENGINE OFICIAL DE PERFORMANCE POR PAÍS (cliente)
//
// Regras (fonte da verdade):
//   • Custo por campanha/dia  = daily_metrics.spend        (Google Ads)
//   • Receita por campanha/dia = daily_metrics.revenue     (GAM já atribuído
//                                                           por utm_campaign)
//   • Receita líquida = revenue * NET_FACTOR (rev share 6,5% aplicado uma vez)
//
// Cruzamento:
//   INNER JOIN campanha↔GAM já ocorre a montante (daily_metrics.revenue).
//   Aqui apenas dividimos POR PAÍS DENTRO DA CAMPANHA usando a única fonte
//   de dimensão país disponível (Google Ads → campaign_country_metrics).
//
//   • share = impressões(país)/impressões(campanha) no mesmo dia
//     fallback: cliques → conversões → custo (só se impressões == 0)
//   • Se a campanha tem receita mas nenhum país cadastrado, a receita cai
//     no bucket "??" (Desconhecido) para que Σ países = Dashboard.
//
// NÃO usar: rateio entre campanhas, estimativa, fallback global por clique,
// receita agregada de site (__aggregate__). Isso quebrava totais.
// ============================================================================
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabasePagination";

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
  share_method: "impressions" | "clicks" | "conversions" | "cost" | "none" | "unknown";
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

const UNKNOWN_CODE = "??";
const UNKNOWN_NAME = "Desconhecido";

export async function computeCountryPerformanceClient(
  p: ClientCountryEngineParams,
): Promise<ClientCountryEngineResult> {
  const warnings: string[] = [];

  // 1) Contas permitidas (filtro por site via account_site_links).
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
    if (allowedAccountIds.length === 0) {
      return empty(p, allowedAccountIds, warnings);
    }
  }

  // 2) Universo de campanhas (mesma regra do Dashboard).
  let resolvedCampaignIds = p.campaignIds
    ? [...new Set(p.campaignIds.map(String))]
    : null;
  if (!resolvedCampaignIds) {
    const data = await fetchAllRows<any>(() => {
      let q = supabase.from("campaigns").select("campaign_id");
      if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
      return q.order("campaign_id");
    });
    resolvedCampaignIds = [
      ...new Set((data ?? []).map((r: any) => String(r.campaign_id)).filter(Boolean)),
    ];
  }
  if (!resolvedCampaignIds || resolvedCampaignIds.length === 0) {
    return empty(p, allowedAccountIds, warnings);
  }

  // 3) daily_metrics — mesma fonte usada pela Dashboard (custo + receita).
  type DRow = {
    campaign_id: string;
    date: string;
    google_account_id: string | null;
    spend: number;
    revenue: number;
    clicks: number;
    conversions: number;
    impressions: number;
  };
  const dailyRows: DRow[] = [];
  for (const chunk of chunk200(resolvedCampaignIds)) {
    const rows = await fetchAllRows<DRow>(() => {
      let q = supabase
        .from("daily_metrics")
        .select("campaign_id, date, google_account_id, spend, revenue, clicks, conversions, impressions")
        .in("campaign_id", chunk)
        .gte("date", p.from)
        .lte("date", p.to);
      if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
      return q.order("date", { ascending: true }).order("campaign_id", { ascending: true });
    });
    dailyRows.push(...rows);
  }

  // 4) campaign_country_metrics — só a dimensão país (custos aqui NÃO são a fonte).
  type CRow = {
    campaign_id: string;
    date: string;
    country_code: string;
    country_name: string | null;
    country_criterion_id: string | null;
    google_account_id: string | null;
    cost: number;
    clicks: number;
    impressions: number;
    conversions: number;
  };
  const countryRows: CRow[] = [];
  for (const chunk of chunk200(resolvedCampaignIds)) {
    const rows = await fetchAllRows<CRow>(() => {
      let q = supabase
        .from("campaign_country_metrics")
        .select("campaign_id, date, country_code, country_name, country_criterion_id, google_account_id, cost, clicks, impressions, conversions")
        .in("campaign_id", chunk)
        .gte("date", p.from)
        .lte("date", p.to);
      if (allowedAccountIds) q = q.in("google_account_id", allowedAccountIds);
      return q.order("date", { ascending: true }).order("campaign_id", { ascending: true });
    });
    countryRows.push(...rows);
  }

  // 5) Índices auxiliares.
  const dailyByCD = new Map<string, DRow>();
  for (const r of dailyRows) {
    const k = `${r.campaign_id}|${r.date}`;
    const prev = dailyByCD.get(k);
    if (!prev) {
      dailyByCD.set(k, { ...r });
    } else {
      prev.spend += Number(r.spend) || 0;
      prev.revenue += Number(r.revenue) || 0;
      prev.clicks += Number(r.clicks) || 0;
      prev.conversions += Number(r.conversions) || 0;
      prev.impressions += Number(r.impressions) || 0;
    }
  }

  // Totais por campanha/dia dentro do country_metrics (para calcular share intra-campanha).
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
  const cellShareAcc = new Map<string, { sum: number; count: number }>();
  const countryRowsByCD = new Map<string, CRow[]>();
  for (const r of countryRows) {
    const k = `${r.campaign_id}|${r.date}`;
    const rows = countryRowsByCD.get(k) ?? [];
    rows.push(r);
    countryRowsByCD.set(k, rows);
  }

  const ensureCell = (
    campaign_id: string,
    country_code: string,
    country_name: string,
    country_criterion_id: string | null,
    google_account_id: string | null,
  ): ClientCountryCell => {
    const key = `${campaign_id}|${country_code}`;
    let c = cells.get(key);
    if (!c) {
      c = {
        campaign_id,
        google_account_id,
        country_code,
        country_name,
        country_criterion_id,
        cost_brl: 0,
        revenue_brl: 0,
        revenue_gross_usd: 0,
        clicks: 0,
        impressions: 0,
        conversions: 0,
        share_method: "none",
        share_pct: 0,
        site_factor_avg: 1,
      };
      cells.set(key, c);
      cellShareAcc.set(key, { sum: 0, count: 0 });
    }
    return c;
  };

  // 6) Distribui custo + receita da Dashboard (daily_metrics) por país
  //    usando share intra-campanha (impressões Ads → fallback clicks→conv→cost).
  for (const [cd, daily] of dailyByCD) {
    const [campaign_id, date] = cd.split("|");
    const rows = countryRowsByCD.get(cd) ?? [];
    const totals = totalsByCD.get(cd);

    const cost = Number(daily.spend) || 0;
    const revenue = Number(daily.revenue) || 0;
    const revenueNet = revenue * p.netFactor;

    if (!rows.length || !totals) {
      // Sem país cadastrado nesse dia — cai no bucket Desconhecido para
      // preservar Σ países = Dashboard.
      const cell = ensureCell(campaign_id, UNKNOWN_CODE, UNKNOWN_NAME, null, daily.google_account_id);
      cell.cost_brl += cost;
      cell.revenue_gross_usd += revenue;
      cell.revenue_brl += revenueNet;
      cell.clicks += Number(daily.clicks) || 0;
      cell.impressions += Number(daily.impressions) || 0;
      cell.conversions += Number(daily.conversions) || 0;
      cell.share_method = "unknown";
      continue;
    }

    let method: ClientCountryCell["share_method"] = "none";
    let denom = 0;
    if (totals.impr > 0)        { method = "impressions"; denom = totals.impr; }
    else if (totals.clicks > 0) { method = "clicks";      denom = totals.clicks; }
    else if (totals.conv > 0)   { method = "conversions"; denom = totals.conv; }
    else if (totals.cost > 0)   { method = "cost";        denom = totals.cost; }

    if (denom <= 0) {
      // Nenhuma métrica de país útil — vai para "??"
      const cell = ensureCell(campaign_id, UNKNOWN_CODE, UNKNOWN_NAME, null, daily.google_account_id);
      cell.cost_brl += cost;
      cell.revenue_gross_usd += revenue;
      cell.revenue_brl += revenueNet;
      cell.share_method = "unknown";
      continue;
    }

    for (const r of rows) {
      const key = `${r.campaign_id}|${r.country_code}`;
      const cell = ensureCell(
        r.campaign_id,
        r.country_code,
        r.country_name ?? r.country_code,
        r.country_criterion_id,
        r.google_account_id ?? daily.google_account_id,
      );

      const impr = Number(r.impressions) || 0;
      const clicks = Number(r.clicks) || 0;
      const conv = Number(r.conversions) || 0;
      const rc = Number(r.cost) || 0;

      const shareValue =
        method === "impressions" ? impr :
        method === "clicks"      ? clicks :
        method === "conversions" ? conv :
                                   rc;
      const share = denom > 0 ? shareValue / denom : 0;
      if (share <= 0) continue;

      cell.cost_brl += cost * share;
      cell.revenue_gross_usd += revenue * share;
      cell.revenue_brl += revenueNet * share;
      cell.clicks += clicks;
      cell.impressions += impr;
      cell.conversions += conv;
      if (!cell.country_criterion_id && r.country_criterion_id) cell.country_criterion_id = r.country_criterion_id;
      if (cell.share_method === "none") cell.share_method = method;

      const acc = cellShareAcc.get(key)!;
      acc.sum += share;
      acc.count += 1;
    }
  }

  for (const [k, cell] of cells) {
    const acc = cellShareAcc.get(k);
    cell.share_pct = acc && acc.count > 0 ? (acc.sum / acc.count) * 100 : 0;
    cell.site_factor_avg = 1;
  }

  // 7) Totais por campanha (para debug/validação).
  const campaignTotals = new Map<string, ClientCampaignTotals>();
  for (const cell of cells.values()) {
    let t = campaignTotals.get(cell.campaign_id);
    if (!t) {
      t = {
        campaign_id: cell.campaign_id,
        cost_brl: 0,
        revenue_brl_net: 0,
        countries: new Set(),
        daily_cost_brl: 0,
        daily_revenue_usd: 0,
        site_revenue_usd: 0,
        site_revenue_brl_gross: 0,
      };
      campaignTotals.set(cell.campaign_id, t);
    }
    t.cost_brl += cell.cost_brl;
    t.revenue_brl_net += cell.revenue_brl;
    if (cell.country_code && cell.country_code !== UNKNOWN_CODE) t.countries.add(cell.country_code);
  }
  for (const [k, v] of dailyByCD) {
    const [campaign_id] = k.split("|");
    const t = campaignTotals.get(campaign_id);
    if (!t) continue;
    t.daily_cost_brl += Number(v.spend) || 0;
    t.daily_revenue_usd += Number(v.revenue) || 0;
    t.site_revenue_usd += Number(v.revenue) || 0;
    t.site_revenue_brl_gross += Number(v.revenue) || 0;
  }

  // Sanity check: cada campanha com receita > 0 tem cells cobrindo 100% do valor.
  for (const t of campaignTotals.values()) {
    const expectedNet = t.daily_revenue_usd * p.netFactor;
    if (expectedNet > 0 && Math.abs(t.revenue_brl_net - expectedNet) / expectedNet > 0.001) {
      warnings.push(
        `Campanha ${t.campaign_id}: soma de países (${t.revenue_brl_net.toFixed(2)}) difere do total Dashboard (${expectedNet.toFixed(2)}).`,
      );
    }
  }

  return {
    cells,
    campaignTotals,
    warnings,
    meta: {
      period: { from: p.from, to: p.to },
      site_id: p.siteId,
      account_ids: allowedAccountIds,
      campaign_count: resolvedCampaignIds.length,
    },
  };
}

function empty(
  p: ClientCountryEngineParams,
  accIds: string[] | null,
  warnings: string[],
): ClientCountryEngineResult {
  return {
    cells: new Map(),
    campaignTotals: new Map(),
    warnings,
    meta: {
      period: { from: p.from, to: p.to },
      site_id: p.siteId,
      account_ids: accIds,
      campaign_count: 0,
    },
  };
}

function chunk200<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 200) out.push(arr.slice(i, i + 200));
  return out;
}
