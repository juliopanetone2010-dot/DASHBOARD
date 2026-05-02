// Engine de regras: avalia métricas dos últimos N dias e gera
// alertas + ações sugeridas (modo híbrido: pausa auto, aumento de orçamento manual).
//
// Roda 100% client-side por enquanto. Quando os edge functions de execução
// estiverem prontos, basta chamar este módulo dentro de um cron edge function.

import type {
  Campaign,
  CampaignAggregate,
  DailyMetric,
  Placement,
  RulesConfig,
} from "@/types/domain";

export interface EngineInput {
  campaigns: Campaign[];
  metrics: DailyMetric[];
  placements: Placement[];
  rules: RulesConfig;
  windowDays?: number;
}

export interface EngineSuggestion {
  campaign_id: string;
  action_type: "pause" | "increase_budget" | "decrease_budget" | "adjust_cpa";
  reason: string;
  severity: "info" | "warning" | "critical";
  auto: boolean; // se true, modo híbrido permite execução automática
  payload?: Record<string, unknown>;
}

export interface EngineAlertDraft {
  severity: "info" | "warning" | "critical";
  category: "bad_campaign" | "bad_placement" | "risk" | "opportunity";
  campaign_id: string | null;
  placement_key: string | null;
  title: string;
  message: string;
  metric_snapshot?: Record<string, unknown>;
}

export interface EngineOutput {
  aggregates: CampaignAggregate[];
  placementAggregates: PlacementAggregate[];
  suggestions: EngineSuggestion[];
  alerts: EngineAlertDraft[];
  totals: {
    spend: number;
    revenue: number;
    profit: number;
    roi: number;
    roas: number;
  };
}

export interface PlacementAggregate {
  placement_key: string;
  campaign_id: string | null;
  site: string | null;
  ad_unit: string | null;
  revenue: number;
  impressions: number;
  ecpm: number;
}

const calcRoi = (revenue: number, spend: number) =>
  spend > 0 ? ((revenue - spend) / spend) * 100 : 0;
const calcRoas = (revenue: number, spend: number) =>
  spend > 0 ? revenue / spend : 0;
const calcEcpm = (revenue: number, impressions: number) =>
  impressions > 0 ? (revenue / impressions) * 1000 : 0;

export function aggregateByCampaign(
  campaigns: Campaign[],
  metrics: DailyMetric[],
): CampaignAggregate[] {
  const byId = new Map<string, CampaignAggregate>();
  for (const c of campaigns) {
    byId.set(c.campaign_id, {
      campaign_id: c.campaign_id,
      name: c.name,
      status: c.status,
      spend: 0, revenue: 0, profit: 0, roi: 0, roas: 0,
      clicks: 0, conversions: 0, impressions: 0, ecpm: 0,
      days: 0,
    });
  }
  const dayCount = new Map<string, Set<string>>();
  for (const m of metrics) {
    let agg = byId.get(m.campaign_id);
    if (!agg) {
      agg = {
        campaign_id: m.campaign_id,
        name: m.campaign_id,
        status: "unknown",
        spend: 0, revenue: 0, profit: 0, roi: 0, roas: 0,
        clicks: 0, conversions: 0, impressions: 0, ecpm: 0,
        days: 0,
      };
      byId.set(m.campaign_id, agg);
    }
    agg.spend += Number(m.spend);
    agg.revenue += Number(m.revenue);
    agg.clicks += Number(m.clicks);
    agg.conversions += Number(m.conversions);
    agg.impressions += Number(m.impressions);
    if (!dayCount.has(m.campaign_id)) dayCount.set(m.campaign_id, new Set());
    dayCount.get(m.campaign_id)!.add(m.date);
  }
  for (const agg of byId.values()) {
    agg.profit = agg.revenue - agg.spend;
    agg.roi = calcRoi(agg.revenue, agg.spend);
    agg.roas = calcRoas(agg.revenue, agg.spend);
    agg.ecpm = calcEcpm(agg.revenue, agg.impressions);
    agg.days = dayCount.get(agg.campaign_id)?.size ?? 0;
  }
  return [...byId.values()].filter((a) => a.spend > 0 || a.revenue > 0);
}

export function aggregateByPlacement(placements: Placement[]): PlacementAggregate[] {
  const map = new Map<string, PlacementAggregate>();
  for (const p of placements) {
    let a = map.get(p.placement_key);
    if (!a) {
      a = {
        placement_key: p.placement_key,
        campaign_id: p.campaign_id,
        site: p.site,
        ad_unit: p.ad_unit,
        revenue: 0,
        impressions: 0,
        ecpm: 0,
      };
      map.set(p.placement_key, a);
    }
    a.revenue += Number(p.revenue);
    a.impressions += Number(p.impressions);
  }
  for (const a of map.values()) a.ecpm = calcEcpm(a.revenue, a.impressions);
  return [...map.values()];
}

/**
 * Avalia regras e produz sugestões + alertas.
 * Modo híbrido (escolha do usuário):
 * - auto_pause_enabled = true → pause vira `auto: true`
 * - auto_boost_enabled = false → aumento de orçamento sempre `auto: false`
 */
export function evaluate(input: EngineInput): EngineOutput {
  const { campaigns, metrics, placements, rules } = input;
  const aggregates = aggregateByCampaign(campaigns, metrics);
  const placementAggregates = aggregateByPlacement(placements);

  const suggestions: EngineSuggestion[] = [];
  const alerts: EngineAlertDraft[] = [];

  for (const agg of aggregates) {
    // Só avalia se gastou o mínimo configurado
    if (agg.spend < rules.min_spend_threshold) continue;

    // Regra 1 — ROI severamente negativo
    if (agg.roi <= rules.max_loss_roi_pct && agg.days >= rules.analysis_days) {
      suggestions.push({
        campaign_id: agg.campaign_id,
        action_type: "pause",
        severity: "critical",
        auto: rules.auto_pause_enabled,
        reason: `ROI ${agg.roi.toFixed(1)}% por ${agg.days} dia(s) — abaixo do limite de ${rules.max_loss_roi_pct}%`,
        payload: { spend: agg.spend, revenue: agg.revenue, days: agg.days },
      });
      alerts.push({
        severity: "critical",
        category: "bad_campaign",
        campaign_id: agg.campaign_id,
        placement_key: null,
        title: `🔥 ${agg.name}`,
        message: `Prejuízo: ROI ${agg.roi.toFixed(1)}% • Gasto ${agg.spend.toFixed(2)} • Receita ${agg.revenue.toFixed(2)}`,
        metric_snapshot: { roi: agg.roi, spend: agg.spend, revenue: agg.revenue },
      });
      continue;
    }

    // Regra 2 — alto ROI → oportunidade de aumento (manual no modo híbrido)
    if (agg.roi >= rules.boost_roi_pct) {
      suggestions.push({
        campaign_id: agg.campaign_id,
        action_type: "increase_budget",
        severity: "info",
        auto: rules.auto_boost_enabled,
        reason: `ROI ${agg.roi.toFixed(1)}% acima do alvo de ${rules.boost_roi_pct}%`,
        payload: { increase_pct: rules.budget_increase_pct },
      });
      alerts.push({
        severity: "info",
        category: "opportunity",
        campaign_id: agg.campaign_id,
        placement_key: null,
        title: `📈 ${agg.name}`,
        message: `Oportunidade: ROI ${agg.roi.toFixed(1)}% — sugerimos aumentar orçamento em ${rules.budget_increase_pct}%`,
      });
      continue;
    }

    // Regra 3 — risco: gasto alto vs receita baixa (mas não no patamar de pausa)
    if (agg.roi < rules.min_roi_pct && agg.spend > rules.min_spend_threshold * 3) {
      alerts.push({
        severity: "warning",
        category: "risk",
        campaign_id: agg.campaign_id,
        placement_key: null,
        title: `⚠️ ${agg.name}`,
        message: `Risco: ROI ${agg.roi.toFixed(1)}% com gasto elevado (${agg.spend.toFixed(2)})`,
      });
    }
  }

  // Placements ruins: receita zerada ou eCPM muito baixo com impressões altas
  const ecpmThreshold = 0.10; // R$ 0,10 por mil
  for (const p of placementAggregates) {
    if (p.impressions > 1000 && p.ecpm < ecpmThreshold) {
      alerts.push({
        severity: "warning",
        category: "bad_placement",
        campaign_id: p.campaign_id,
        placement_key: p.placement_key,
        title: `🧱 Placement fraco: ${p.site ?? p.placement_key}`,
        message: `eCPM ${p.ecpm.toFixed(2)} com ${p.impressions} impressões`,
      });
    }
  }

  const totals = aggregates.reduce(
    (acc, a) => {
      acc.spend += a.spend;
      acc.revenue += a.revenue;
      return acc;
    },
    { spend: 0, revenue: 0, profit: 0, roi: 0, roas: 0 },
  );
  totals.profit = totals.revenue - totals.spend;
  totals.roi = calcRoi(totals.revenue, totals.spend);
  totals.roas = calcRoas(totals.revenue, totals.spend);

  return { aggregates, placementAggregates, suggestions, alerts, totals };
}
