import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import type { EngineAlertDraft } from "@/engine/rules";
import type {
  Alert as DomainAlert,
  AutomationAction,
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
  isGuest: boolean;
  saveRules: (rules: RulesConfig) => Promise<void>;
  acknowledgeAlert: (id: string) => Promise<void>;
  queueAction: (campaignId: string, action: "pause" | "increase_budget", reason: string) => Promise<void>;
  insertSampleData: () => Promise<void>;
  persistEngineAlerts: (alerts: EngineAlertDraft[]) => Promise<void>;
}

const GUEST_USER_ID = "guest";
const GUEST_STORE_KEY = "arbitrage-dashboard-guest-v1";

const RULES_DEFAULT: RulesConfig = {
  user_id: GUEST_USER_ID,
  min_roi_pct: 10,
  max_loss_roi_pct: -20,
  boost_roi_pct: 40,
  analysis_days: 2,
  min_spend_threshold: 50,
  auto_pause_enabled: true,
  auto_boost_enabled: false,
  budget_increase_pct: 20,
};

interface GuestStore {
  campaigns: Campaign[];
  metrics: DailyMetric[];
  placements: Placement[];
  rules: RulesConfig;
  alerts: DomainAlert[];
  actions: AutomationAction[];
}

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

const emptyGuestStore = (): GuestStore => ({
  campaigns: [],
  metrics: [],
  placements: [],
  rules: RULES_DEFAULT,
  alerts: [],
  actions: [],
});

const loadGuestStore = (): GuestStore => {
  try {
    const raw = localStorage.getItem(GUEST_STORE_KEY);
    if (!raw) return emptyGuestStore();
    return { ...emptyGuestStore(), ...JSON.parse(raw) };
  } catch {
    return emptyGuestStore();
  }
};

const saveGuestStore = (store: GuestStore) => {
  localStorage.setItem(GUEST_STORE_KEY, JSON.stringify(store));
};

const createSampleStore = (userId: string, rules: RulesConfig): GuestStore => {
  const today = new Date();
  const dayOf = (offset: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  const samples = [
    { campaign_id: "C-1001", name: "Display - Notícias BR", spend: 320, revenue: 540 },
    { campaign_id: "C-1002", name: "Display - Esportes", spend: 480, revenue: 720 },
    { campaign_id: "C-1003", name: "Display - Lifestyle", spend: 290, revenue: 95 },
    { campaign_id: "C-1004", name: "Display - Tech YT", spend: 660, revenue: 1240 },
    { campaign_id: "C-1005", name: "Display - Finanças", spend: 220, revenue: 712 },
  ];

  const campaigns: Campaign[] = samples.map((s) => ({
    id: uid(),
    user_id: userId,
    campaign_id: s.campaign_id,
    name: s.name,
    status: "enabled",
    channel_type: "DISPLAY",
    budget_micros: null,
    target_cpa_micros: null,
  }));

  const metrics: DailyMetric[] = samples.flatMap((s) => Array.from({ length: 3 }, (_, d) => {
    const spend = s.spend / 3;
    const revenue = s.revenue / 3;
    return {
      id: uid(),
      user_id: userId,
      campaign_id: s.campaign_id,
      date: dayOf(d),
      spend,
      revenue,
      profit: revenue - spend,
      roi: spend > 0 ? ((revenue - spend) / spend) * 100 : 0,
      roas: spend > 0 ? revenue / spend : 0,
      clicks: Math.round(spend * 8),
      conversions: Math.round(revenue / 30),
      impressions: Math.round(spend * 320),
      ecpm: spend > 0 ? (revenue / (spend * 320)) * 1000 : 0,
    };
  }));

  const placements: Placement[] = [
    { id: uid(), user_id: userId, placement_key: "site-a/box-300x250", campaign_id: "C-1001", site: "Notícias BR", ad_unit: "box-300x250", date: dayOf(0), impressions: 25000, revenue: 180, ecpm: 7.2 },
    { id: uid(), user_id: userId, placement_key: "site-b/sticky-728", campaign_id: "C-1004", site: "Tech YT", ad_unit: "sticky-728", date: dayOf(0), impressions: 41000, revenue: 410, ecpm: 10.0 },
    { id: uid(), user_id: userId, placement_key: "site-c/footer", campaign_id: "C-1003", site: "Lifestyle", ad_unit: "footer", date: dayOf(0), impressions: 18000, revenue: 1.6, ecpm: 0.09 },
  ];

  return { campaigns, metrics, placements, rules: { ...rules, user_id: userId }, alerts: [], actions: [] };
};

export function useDashboardData(): DashboardData {
  const { user, loading: authLoading } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [metrics, setMetrics] = useState<DailyMetric[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [rules, setRules] = useState<RulesConfig | null>(null);
  const [alerts, setAlerts] = useState<DomainAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const refresh = async () => {
    setLoading(true);
    if (!user) {
      const store = loadGuestStore();
      setCampaigns(store.campaigns);
      setMetrics(store.metrics);
      setPlacements(store.placements);
      setRules(store.rules);
      setAlerts(store.alerts);
      setLastSyncedAt(new Date());
      setLoading(false);
      return;
    }

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
    setRules((r.data as RulesConfig) ?? ({ ...RULES_DEFAULT, user_id: user.id } as RulesConfig));
    setAlerts((a.data ?? []) as DomainAlert[]);
    setLastSyncedAt(new Date());
    setLoading(false);
  };

  const saveRules = async (nextRules: RulesConfig) => {
    if (!user) {
      const store = loadGuestStore();
      const next = { ...nextRules, user_id: GUEST_USER_ID };
      saveGuestStore({ ...store, rules: next });
      setRules(next);
      return;
    }
    await supabase.from("rules_config").upsert({ ...nextRules, user_id: user.id }, { onConflict: "user_id" });
    await refresh();
  };

  const acknowledgeAlert = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      const alerts = store.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a));
      saveGuestStore({ ...store, alerts });
      setAlerts(alerts);
      return;
    }
    await supabase.from("alerts").update({ acknowledged: true }).eq("id", id);
    await refresh();
  };

  const queueAction = async (campaignId: string, action: "pause" | "increase_budget", reason: string) => {
    if (!user) {
      const store = loadGuestStore();
      const actions = [{
        id: uid(),
        campaign_id: campaignId,
        action_type: action,
        reason,
        payload: null,
        status: "pending" as const,
        created_at: new Date().toISOString(),
      }, ...store.actions];
      saveGuestStore({ ...store, actions });
      return;
    }
    await supabase.from("automation_actions").insert({
      user_id: user.id,
      campaign_id: campaignId,
      action_type: action,
      reason,
      status: "pending",
    });
  };

  const insertSampleData = async () => {
    const store = createSampleStore(user?.id ?? GUEST_USER_ID, rules ?? RULES_DEFAULT);
    if (!user) {
      saveGuestStore(store);
      await refresh();
      return;
    }
    await supabase.from("campaigns").upsert(
      store.campaigns.map(({ id, ...row }) => row),
      { onConflict: "user_id,campaign_id" },
    );
    await supabase.from("daily_metrics").upsert(
      store.metrics.map(({ id, ...row }) => row),
      { onConflict: "user_id,campaign_id,date" },
    );
    await supabase.from("placements").upsert(
      store.placements.map(({ id, ...row }) => row),
      { onConflict: "user_id,placement_key,date" },
    );
    await refresh();
  };

  const persistEngineAlerts = async (drafts: EngineAlertDraft[]) => {
    if (drafts.length === 0) return;
    if (!user) {
      const store = loadGuestStore();
      const existingTitles = new Set(store.alerts.filter((a) => !a.acknowledged).map((a) => a.title));
      const additions = drafts
        .filter((a) => !existingTitles.has(a.title))
        .map((a): DomainAlert => ({
          id: uid(),
          severity: a.severity,
          category: a.category,
          campaign_id: a.campaign_id,
          placement_key: a.placement_key,
          title: a.title,
          message: a.message,
          acknowledged: false,
          created_at: new Date().toISOString(),
        }));
      if (additions.length === 0) return;
      const alerts = [...additions, ...store.alerts];
      saveGuestStore({ ...store, alerts });
      setAlerts(alerts);
      return;
    }
    await supabase.from("alerts").insert(drafts.map((a) => ({
      user_id: user.id,
      severity: a.severity,
      category: a.category,
      campaign_id: a.campaign_id,
      placement_key: a.placement_key,
      title: a.title,
      message: a.message,
      metric_snapshot: (a.metric_snapshot ?? null) as never,
    })));
    await refresh();
  };

  useEffect(() => {
    if (!authLoading) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  return {
    campaigns,
    metrics,
    placements,
    rules,
    alerts,
    loading,
    refresh,
    lastSyncedAt,
    isGuest: !user,
    saveRules,
    acknowledgeAlert,
    queueAction,
    insertSampleData,
    persistEngineAlerts,
  };
}
