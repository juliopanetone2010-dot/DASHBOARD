import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import type {
  Alert as DomainAlert,
  Campaign,
  DailyMetric,
  Placement,
  RulesConfig,
} from "@/types/domain";

export interface DashboardData {
  campaigns: Campaign[];
  metrics: DailyMetric[];
  placements: Placement[];
  rules: RulesConfig | null;
  alerts: DomainAlert[];
  loading: boolean;
  refresh: () => Promise<void>;
  lastSyncedAt: Date | null;
}

const RULES_DEFAULT: Partial<RulesConfig> = {
  min_roi_pct: 10,
  max_loss_roi_pct: -20,
  boost_roi_pct: 40,
  analysis_days: 2,
  min_spend_threshold: 50,
  auto_pause_enabled: true,
  auto_boost_enabled: false,
  budget_increase_pct: 20,
};

export function useDashboardData(): DashboardData {
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [metrics, setMetrics] = useState<DailyMetric[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [rules, setRules] = useState<RulesConfig | null>(null);
  const [alerts, setAlerts] = useState<DomainAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    const [c, m, p, r, a] = await Promise.all([
      supabase.from("campaigns").select("*").order("name"),
      supabase.from("daily_metrics").select("*").order("date", { ascending: false }).limit(1000),
      supabase.from("placements").select("*").order("date", { ascending: false }).limit(1000),
      supabase.from("rules_config").select("*").maybeSingle(),
      supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(50),
    ]);
    setCampaigns((c.data ?? []) as Campaign[]);
    setMetrics((m.data ?? []) as DailyMetric[]);
    setPlacements((p.data ?? []) as Placement[]);
    setRules((r.data as RulesConfig) ?? ({ user_id: user.id, ...RULES_DEFAULT } as RulesConfig));
    setAlerts((a.data ?? []) as DomainAlert[]);
    setLastSyncedAt(new Date());
    setLoading(false);
  };

  useEffect(() => {
    if (user) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return { campaigns, metrics, placements, rules, alerts, loading, refresh, lastSyncedAt };
}
