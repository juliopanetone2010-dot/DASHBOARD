// "Melhor Match por Bloco (Ad Unit)" — análise por Ad Unit dentro de UMA campanha.
//
// Regras:
// - Só considera dias com Requests >= MIN_REQUESTS para aquele Ad Unit.
// - Após filtrar, ordena os dias pelo ROI (da campanha) DESC e pega os 3 melhores.
// - Se houver menos de 3 dias válidos, usa todos os disponíveis.
// - Se não houver nenhum, retorna null (com motivo).
// - Média simples dos 3 (ou N) melhores dias em: matchRate, fillRate, ecpm, requests, revenue, roi.
//
// Fontes:
// - Impressões/Receita por Ad Unit/dia: gam_placement_revenue
// - Match rate + total_requests (por dia, a nível de campanha): gam_campaign_source_revenue
//   (assumido idêntico para todos os Ad Units da campanha no mesmo dia — o GAM reporta
//    match rate por campanha, não por bloco)
// - ROI da campanha por dia: daily_metrics (via CampaignHistoryButton)
//
// Requests por Ad Unit/dia é ESTIMADO: matched_do_bloco / (match_rate_do_dia/100).
// Fill rate == match rate (mesmo denominador aqui).

export const MIN_REQUESTS_PER_DAY = 100;
export const TOP_DAYS = 3;

export type CampaignDayContext = {
  date: string;
  matchRatePct: number | null; // 0..100
  roi: number;                 // 0..100 percent
};

export type AdUnitDay = {
  date: string;
  matched: number;
  requests: number;   // estimado
  matchRate: number;  // % da campanha nesse dia
  fillRate: number;   // % (mesmo que matchRate no nosso modelo)
  ecpm: number;       // USD
  revenue: number;    // USD
  roi: number;        // % da campanha nesse dia
};

export type AdUnitAnalysis = {
  adUnit: string;
  totalDays: number;          // dias com dado no período
  validDays: number;          // dias após filtro requests>=100
  usedDays: AdUnitDay[];      // top N por ROI
  avg: {
    matchRate: number;
    fillRate: number;
    ecpm: number;
    requests: number;
    revenue: number;
    roi: number;
  } | null;
  reason?: string;
};

export type RawPlacementRow = {
  date: string;
  placement: string;
  impressions: number;
  revenue_usd: number;
};

export function buildAdUnitAnalyses(
  rawRows: RawPlacementRow[],
  campaignDayCtx: Map<string, CampaignDayContext>,
): AdUnitAnalysis[] {
  // Agrega por (placement, date)
  type Key = string;
  const byUnit = new Map<string, Map<Key, { imp: number; rev: number }>>();
  for (const r of rawRows) {
    const unit = r.placement || "—";
    const date = String(r.date);
    if (!byUnit.has(unit)) byUnit.set(unit, new Map());
    const dayMap = byUnit.get(unit)!;
    const cur = dayMap.get(date) ?? { imp: 0, rev: 0 };
    cur.imp += Number(r.impressions ?? 0);
    cur.rev += Number(r.revenue_usd ?? 0);
    dayMap.set(date, cur);
  }

  const out: AdUnitAnalysis[] = [];
  for (const [adUnit, dayMap] of byUnit) {
    const allDays: AdUnitDay[] = [];
    for (const [date, v] of dayMap) {
      const ctx = campaignDayCtx.get(date);
      const rate = ctx?.matchRatePct;
      if (v.imp <= 0 || rate == null || rate <= 0) continue;
      const requests = v.imp / (rate / 100);
      allDays.push({
        date,
        matched: v.imp,
        requests,
        matchRate: rate,
        fillRate: rate, // mesmo denominador; sem dado de fill separado no GAM aqui
        ecpm: v.imp > 0 ? (v.rev / v.imp) * 1000 : 0,
        revenue: v.rev,
        roi: ctx?.roi ?? 0,
      });
    }
    const totalDays = allDays.length;
    const valid = allDays.filter((d) => d.requests >= MIN_REQUESTS_PER_DAY);
    valid.sort((a, b) => b.roi - a.roi);
    const used = valid.slice(0, TOP_DAYS);

    if (used.length === 0) {
      out.push({
        adUnit,
        totalDays,
        validDays: 0,
        usedDays: [],
        avg: null,
        reason:
          totalDays === 0
            ? "Sem dados no período."
            : `O bloco não possui nenhum dia com pelo menos ${MIN_REQUESTS_PER_DAY} requests.`,
      });
      continue;
    }

    const avgOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    out.push({
      adUnit,
      totalDays,
      validDays: valid.length,
      usedDays: used,
      avg: {
        matchRate: avgOf(used.map((x) => x.matchRate)),
        fillRate: avgOf(used.map((x) => x.fillRate)),
        ecpm: avgOf(used.map((x) => x.ecpm)),
        requests: avgOf(used.map((x) => x.requests)),
        revenue: avgOf(used.map((x) => x.revenue)),
        roi: avgOf(used.map((x) => x.roi)),
      },
    });
  }

  // Ordena: primeiro os que têm análise, por matchRate médio DESC; depois os sem dados.
  out.sort((a, b) => {
    if (a.avg && !b.avg) return -1;
    if (!a.avg && b.avg) return 1;
    if (a.avg && b.avg) return b.avg.matchRate - a.avg.matchRate;
    return a.adUnit.localeCompare(b.adUnit);
  });

  return out;
}
