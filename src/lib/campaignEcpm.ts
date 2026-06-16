/**
 * Shared eCPM helper for campaigns.
 *
 * Single formula used across the dashboard (CampaignsTable, RestartCampaignButton,
 * CampaignHistoryButton, Funil): receita GAM / impressões GAM * 1000.
 *
 * Fonte canônica: gam_placement_revenue (agregada por campaign_id no período).
 */
export interface EcpmResult {
  ecpm: number;
  revenueUsd: number;
  impressions: number;
  formula: string;
  source: string;
}

export function calculateCampaignEcpm(
  revenueUsd: number,
  impressions: number,
  source: string = "gam_placement_revenue",
): EcpmResult {
  const rev = Number(revenueUsd) || 0;
  const imp = Number(impressions) || 0;
  const ecpm = imp > 0 ? (rev / imp) * 1000 : 0;
  return {
    ecpm,
    revenueUsd: rev,
    impressions: imp,
    formula: "eCPM = receita_gam / impressões_gam * 1000",
    source,
  };
}

export function ecpmDebugText(r: EcpmResult): string {
  return [
    `Receita GAM: $${r.revenueUsd.toFixed(2)}`,
    `Impressões GAM: ${r.impressions.toLocaleString()}`,
    `${r.formula}`,
    `eCPM = $${r.ecpm.toFixed(2)}`,
    `Fonte: ${r.source}`,
  ].join("\n");
}
