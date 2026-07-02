// Melhor Match por Ad Unit (Bloco de Anúncios) — cruzamento GAM URL x AD_UNIT.
// Regras:
//  - Últimos N dias (default 30)
//  - Filtra dias em que a campanha específica gerou custo > 0 (isolamento por campanha)
//  - Ignora dias com menos de 100 ad_requests para aquele ad unit
//  - Ordena por ROI da campanha e pega top 3 dias por ad unit
//  - Melhor média de Match Rate = média dos match_rate desses top 3 dias

export type AdUnitDailyRow = {
  date: string;
  ad_unit_name: string;
  ad_requests: number;
  matched_impressions: number;
  revenue_usd: number;
  match_rate_pct: number | null;
};

export type CampaignDailyRoi = {
  date: string;
  cost: number;
  netRoi: number;
  netProfit: number;
};

export type AdUnitBestMatch = {
  adUnitName: string;
  eligibleDays: number;
  totalDays: number;
  topDays: Array<{
    date: string;
    roi: number;
    profit: number;
    matchRate: number;
    adRequests: number;
    matched: number;
    revenueUsd: number;
  }>;
  bestMatchAvg: number | null;   // média dos top-3 dias por ROI
  avgRoi: number | null;
};

export const AD_UNIT_MIN_REQUESTS = 100;
export const AD_UNIT_TOP_N = 3;

export function buildAdUnitBestMatches(
  rows: AdUnitDailyRow[],
  campaignDays: CampaignDailyRoi[],
): AdUnitBestMatch[] {
  const roiByDate = new Map<string, CampaignDailyRoi>();
  for (const d of campaignDays) roiByDate.set(d.date, d);

  const byAdUnit = new Map<string, AdUnitDailyRow[]>();
  for (const r of rows) {
    if (!r.ad_unit_name) continue;
    const list = byAdUnit.get(r.ad_unit_name) ?? [];
    list.push(r);
    byAdUnit.set(r.ad_unit_name, list);
  }

  const out: AdUnitBestMatch[] = [];
  for (const [adUnitName, arr] of byAdUnit) {
    // Agrega por dia (uma URL pode aparecer múltiplas vezes se url_normalized igual mas raw diferente).
    const byDate = new Map<string, { ad_requests: number; matched: number; revenue: number }>();
    for (const r of arr) {
      const cur = byDate.get(r.date) ?? { ad_requests: 0, matched: 0, revenue: 0 };
      cur.ad_requests += r.ad_requests;
      cur.matched += r.matched_impressions;
      cur.revenue += r.revenue_usd;
      byDate.set(r.date, cur);
    }

    const eligible: AdUnitBestMatch["topDays"] = [];
    for (const [date, v] of byDate) {
      const camp = roiByDate.get(date);
      if (!camp || camp.cost <= 0) continue;               // isolamento por campanha
      if (v.ad_requests < AD_UNIT_MIN_REQUESTS) continue;  // filtro de volume
      const matchRate = v.ad_requests > 0 ? (v.matched / v.ad_requests) * 100 : 0;
      eligible.push({
        date,
        roi: camp.netRoi,
        profit: camp.netProfit,
        matchRate,
        adRequests: v.ad_requests,
        matched: v.matched,
        revenueUsd: v.revenue,
      });
    }

    // Top N por ROI (desc)
    eligible.sort((a, b) => b.roi - a.roi);
    const top = eligible.slice(0, AD_UNIT_TOP_N);
    const bestMatchAvg = top.length ? top.reduce((s, x) => s + x.matchRate, 0) / top.length : null;
    const avgRoi = top.length ? top.reduce((s, x) => s + x.roi, 0) / top.length : null;

    out.push({
      adUnitName,
      totalDays: byDate.size,
      eligibleDays: eligible.length,
      topDays: top,
      bestMatchAvg,
      avgRoi,
    });
  }

  // Ordena por bestMatchAvg desc (nulls no fim)
  out.sort((a, b) => (b.bestMatchAvg ?? -Infinity) - (a.bestMatchAvg ?? -Infinity));
  return out;
}

export function normalizeUrlKey(raw: string): string {
  if (!raw) return "";
  try {
    let t = decodeURIComponent(String(raw)).toLowerCase().trim();
    t = t.replace(/^https?:\/\//, "").replace(/^www\./, "");
    t = t.split("?")[0].split("#")[0];
    t = t.replace(/\/+$/, "");
    return t;
  } catch {
    let t = String(raw).toLowerCase().trim();
    t = t.replace(/^https?:\/\//, "").replace(/^www\./, "");
    t = t.split("?")[0].split("#")[0];
    t = t.replace(/\/+$/, "");
    return t;
  }
}
