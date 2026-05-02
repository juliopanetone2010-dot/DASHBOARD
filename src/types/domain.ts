// Tipos do domínio (espelham as tabelas do banco)
export interface DailyMetric {
  id: string;
  user_id: string;
  campaign_id: string;
  date: string; // yyyy-mm-dd
  spend: number;
  clicks: number;
  conversions: number;
  impressions: number;
  revenue: number;
  profit: number;
  roi: number;
  roas: number;
  ecpm: number;
}

export interface Campaign {
  id: string;
  user_id: string;
  campaign_id: string;
  name: string;
  status: string;
  channel_type: string | null;
  budget_micros: number | null;
  target_cpa_micros: number | null;
}

export interface Placement {
  id: string;
  user_id: string;
  campaign_id: string | null;
  placement_key: string;
  site: string | null;
  ad_unit: string | null;
  date: string;
  impressions: number;
  revenue: number;
  ecpm: number;
}

export interface RulesConfig {
  user_id: string;
  min_roi_pct: number;
  max_loss_roi_pct: number;
  boost_roi_pct: number;
  analysis_days: number;
  min_spend_threshold: number;
  auto_pause_enabled: boolean;
  auto_boost_enabled: boolean;
  budget_increase_pct: number;
}

export interface Alert {
  id: string;
  severity: "info" | "warning" | "critical";
  category: string;
  campaign_id: string | null;
  placement_key: string | null;
  title: string;
  message: string | null;
  acknowledged: boolean;
  created_at: string;
}

export interface AutomationAction {
  id: string;
  campaign_id: string;
  action_type: "pause" | "increase_budget" | "decrease_budget" | "adjust_cpa";
  reason: string | null;
  payload: Record<string, unknown> | null;
  status: "pending" | "approved" | "executed" | "rejected" | "failed";
  created_at: string;
}

// Agregação por campanha (para tabela e rankings)
export interface CampaignAggregate {
  campaign_id: string;
  name: string;
  status: string;
  spend: number;
  revenue: number;
  profit: number;
  roi: number;
  roas: number;
  clicks: number;
  conversions: number;
  impressions: number;
  ecpm: number;
  days: number;
}
