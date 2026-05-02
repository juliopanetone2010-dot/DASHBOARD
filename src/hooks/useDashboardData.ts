import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import type { EngineAlertDraft } from "@/engine/rules";
import type {
  AccountSiteLink,
  Alert as DomainAlert,
  AutomationAction,
  Campaign,
  DailyMetric,
  GamAccount,
  GoogleAccount,
  Placement,
  RulesConfig,
  Site,
} from "@/types/domain";

export interface DashboardData {
  campaigns: Campaign[];
  metrics: DailyMetric[];
  placements: Placement[];
  rules: RulesConfig | null;
  alerts: DomainAlert[];
  googleAccounts: GoogleAccount[];
  gamAccounts: GamAccount[];
  sites: Site[];
  links: AccountSiteLink[];
  loading: boolean;
  refresh: () => Promise<void>;
  lastSyncedAt: Date | null;
  isGuest: boolean;
  saveRules: (rules: RulesConfig) => Promise<void>;
  acknowledgeAlert: (id: string) => Promise<void>;
  queueAction: (campaignId: string, action: "pause" | "increase_budget", reason: string) => Promise<void>;
  insertSampleData: () => Promise<void>;
  persistEngineAlerts: (alerts: EngineAlertDraft[]) => Promise<void>;
  // CRUD multi-conta
  addGoogleAccount: (input: Partial<GoogleAccount>) => Promise<void>;
  removeGoogleAccount: (id: string) => Promise<void>;
  addGamAccount: (input: Partial<GamAccount>) => Promise<void>;
  removeGamAccount: (id: string) => Promise<void>;
  addSite: (input: Partial<Site>) => Promise<void>;
  removeSite: (id: string) => Promise<void>;
  addLink: (googleAccountId: string, siteId: string) => Promise<void>;
  removeLink: (id: string) => Promise<void>;
}

const GUEST_USER_ID = "guest";
const GUEST_STORE_KEY = "arbitrage-dashboard-guest-v2";

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
  googleAccounts: GoogleAccount[];
  gamAccounts: GamAccount[];
  sites: Site[];
  links: AccountSiteLink[];
}

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

const emptyGuestStore = (): GuestStore => ({
  campaigns: [],
  metrics: [],
  placements: [],
  rules: RULES_DEFAULT,
  alerts: [],
  actions: [],
  googleAccounts: [],
  gamAccounts: [],
  sites: [],
  links: [],
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

  // 2 contas Ads + 2 sites GAM + vínculos
  const accA: GoogleAccount = {
    id: uid(), user_id: userId, customer_id: "123-456-7890",
    login_customer_id: null, account_name: "MCC Principal", is_mcc: true,
    status: "connected",
  };
  const accB: GoogleAccount = {
    id: uid(), user_id: userId, customer_id: "987-654-3210",
    login_customer_id: "123-456-7890", account_name: "Sub-conta Display BR", is_mcc: false,
    status: "connected",
  };
  const siteA: Site = {
    id: uid(), user_id: userId, name: "Notícias BR", domain: "noticiasbr.com",
    network_code: "21700000", status: "active",
  };
  const siteB: Site = {
    id: uid(), user_id: userId, name: "Tech YT", domain: "techyt.com",
    network_code: "21700000", status: "active",
  };
  const gam: GamAccount = {
    id: uid(), user_id: userId, network_code: "21700000",
    account_name: "Rede Principal", service_account_email: null, status: "pending",
  };
  const links: AccountSiteLink[] = [
    { id: uid(), user_id: userId, google_account_id: accB.id, site_id: siteA.id },
    { id: uid(), user_id: userId, google_account_id: accB.id, site_id: siteB.id },
  ];

  const samples = [
    { campaign_id: "C-1001", name: "Display - Notícias BR", spend: 320, revenue: 540, accId: accB.id, siteId: siteA.id },
    { campaign_id: "C-1002", name: "Display - Esportes", spend: 480, revenue: 720, accId: accB.id, siteId: siteA.id },
    { campaign_id: "C-1003", name: "Display - Lifestyle", spend: 290, revenue: 95, accId: accB.id, siteId: siteB.id },
    { campaign_id: "C-1004", name: "Display - Tech YT", spend: 660, revenue: 1240, accId: accB.id, siteId: siteB.id },
    { campaign_id: "C-1005", name: "Display - Finanças", spend: 220, revenue: 712, accId: accB.id, siteId: siteB.id },
  ];

  const campaigns: Campaign[] = samples.map((s) => ({
    id: uid(),
    user_id: userId,
    google_account_id: s.accId,
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
      google_account_id: s.accId,
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

  const placements: Placement[] = samples.map((s) => ({
    id: uid(),
    user_id: userId,
    site_id: s.siteId,
    placement_key: `${s.siteId.slice(0, 6)}/${s.campaign_id}_box-300x250`,
    campaign_id: s.campaign_id,
    site: s.siteId === siteA.id ? siteA.name : siteB.name,
    ad_unit: "box-300x250",
    date: dayOf(0),
    impressions: Math.round(s.revenue * 350),
    revenue: s.revenue * 0.9,
    ecpm: 0,
  }));

  return {
    campaigns,
    metrics,
    placements,
    rules: { ...rules, user_id: userId },
    alerts: [],
    actions: [],
    googleAccounts: [accA, accB],
    gamAccounts: [gam],
    sites: [siteA, siteB],
    links,
  };
};

export function useDashboardData(): DashboardData {
  const { user, loading: authLoading } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [metrics, setMetrics] = useState<DailyMetric[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [rules, setRules] = useState<RulesConfig | null>(null);
  const [alerts, setAlerts] = useState<DomainAlert[]>([]);
  const [googleAccounts, setGoogleAccounts] = useState<GoogleAccount[]>([]);
  const [gamAccounts, setGamAccounts] = useState<GamAccount[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [links, setLinks] = useState<AccountSiteLink[]>([]);
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
      setGoogleAccounts(store.googleAccounts);
      setGamAccounts(store.gamAccounts);
      setSites(store.sites);
      setLinks(store.links);
      setLastSyncedAt(new Date());
      setLoading(false);
      return;
    }

    const [c, m, p, r, a, ga, gam, s, l] = await Promise.all([
      supabase.from("campaigns").select("*").order("name"),
      supabase.from("daily_metrics").select("*").order("date", { ascending: false }).limit(1000),
      supabase.from("placements").select("*").order("date", { ascending: false }).limit(1000),
      supabase.from("rules_config").select("*").maybeSingle(),
      supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("google_accounts").select("*").order("account_name"),
      supabase.from("gam_accounts").select("*").order("account_name"),
      supabase.from("sites").select("*").order("name"),
      supabase.from("account_site_links").select("*"),
    ]);
    setCampaigns((c.data ?? []) as Campaign[]);
    setMetrics((m.data ?? []) as DailyMetric[]);
    setPlacements((p.data ?? []) as Placement[]);
    setRules((r.data as RulesConfig) ?? ({ ...RULES_DEFAULT, user_id: user.id } as RulesConfig));
    setAlerts((a.data ?? []) as DomainAlert[]);
    setGoogleAccounts((ga.data ?? []) as GoogleAccount[]);
    setGamAccounts((gam.data ?? []) as GamAccount[]);
    setSites((s.data ?? []) as Site[]);
    setLinks((l.data ?? []) as AccountSiteLink[]);
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
      const updated = store.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a));
      saveGuestStore({ ...store, alerts: updated });
      setAlerts(updated);
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
    // Para usuários logados só populamos as campanhas/metrics/placements de exemplo;
    // contas/sites devem ser criados pelo painel de Integrações para serem reais.
    await supabase.from("campaigns").upsert(
      store.campaigns.map(({ id, google_account_id, ...row }) => row),
      { onConflict: "user_id,campaign_id" },
    );
    await supabase.from("daily_metrics").upsert(
      store.metrics.map(({ id, google_account_id, ...row }) => row),
      { onConflict: "user_id,campaign_id,date" },
    );
    await supabase.from("placements").upsert(
      store.placements.map(({ id, site_id, ...row }) => row),
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
      const updated = [...additions, ...store.alerts];
      saveGuestStore({ ...store, alerts: updated });
      setAlerts(updated);
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

  // ===== CRUD multi-conta =====

  const addGoogleAccount = async (input: Partial<GoogleAccount>) => {
    const row = {
      customer_id: input.customer_id ?? "",
      login_customer_id: input.login_customer_id ?? null,
      account_name: input.account_name ?? null,
      is_mcc: input.is_mcc ?? false,
      status: input.status ?? "pending",
    };
    if (!user) {
      const store = loadGuestStore();
      const created: GoogleAccount = {
        id: uid(), user_id: GUEST_USER_ID, ...row,
      } as GoogleAccount;
      saveGuestStore({ ...store, googleAccounts: [...store.googleAccounts, created] });
      setGoogleAccounts((prev) => [...prev, created]);
      return;
    }
    await supabase.from("google_accounts").insert({ ...row, user_id: user.id });
    await refresh();
  };

  const removeGoogleAccount = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      const next = store.googleAccounts.filter((a) => a.id !== id);
      const linksNext = store.links.filter((l) => l.google_account_id !== id);
      saveGuestStore({ ...store, googleAccounts: next, links: linksNext });
      setGoogleAccounts(next);
      setLinks(linksNext);
      return;
    }
    await supabase.from("account_site_links").delete().eq("google_account_id", id);
    await supabase.from("google_accounts").delete().eq("id", id);
    await refresh();
  };

  const addGamAccount = async (input: Partial<GamAccount>) => {
    const row = {
      network_code: input.network_code ?? "",
      account_name: input.account_name ?? null,
      service_account_email: input.service_account_email ?? null,
      status: input.status ?? "pending",
    };
    if (!user) {
      const store = loadGuestStore();
      const created: GamAccount = { id: uid(), user_id: GUEST_USER_ID, ...row } as GamAccount;
      saveGuestStore({ ...store, gamAccounts: [...store.gamAccounts, created] });
      setGamAccounts((prev) => [...prev, created]);
      return;
    }
    await supabase.from("gam_accounts").insert({ ...row, user_id: user.id });
    await refresh();
  };

  const removeGamAccount = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      const next = store.gamAccounts.filter((a) => a.id !== id);
      saveGuestStore({ ...store, gamAccounts: next });
      setGamAccounts(next);
      return;
    }
    await supabase.from("gam_accounts").delete().eq("id", id);
    await refresh();
  };

  const addSite = async (input: Partial<Site>) => {
    const row = {
      name: input.name ?? "",
      domain: input.domain ?? "",
      network_code: input.network_code ?? "",
      gam_account_id: input.gam_account_id ?? null,
      status: input.status ?? "active",
    };
    if (!user) {
      const store = loadGuestStore();
      const created: Site = { id: uid(), user_id: GUEST_USER_ID, ...row } as Site;
      saveGuestStore({ ...store, sites: [...store.sites, created] });
      setSites((prev) => [...prev, created]);
      return;
    }
    await supabase.from("sites").insert({ ...row, user_id: user.id });
    await refresh();
  };

  const removeSite = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      const next = store.sites.filter((s) => s.id !== id);
      const linksNext = store.links.filter((l) => l.site_id !== id);
      saveGuestStore({ ...store, sites: next, links: linksNext });
      setSites(next);
      setLinks(linksNext);
      return;
    }
    await supabase.from("account_site_links").delete().eq("site_id", id);
    await supabase.from("sites").delete().eq("id", id);
    await refresh();
  };

  const addLink = async (googleAccountId: string, siteId: string) => {
    if (!user) {
      const store = loadGuestStore();
      // Regra 1:1 — remove qualquer vínculo existente desta conta antes de criar o novo
      const filtered = store.links.filter((l) => l.google_account_id !== googleAccountId);
      const created: AccountSiteLink = {
        id: uid(), user_id: GUEST_USER_ID,
        google_account_id: googleAccountId, site_id: siteId,
      };
      const next = [...filtered, created];
      saveGuestStore({ ...store, links: next });
      setLinks(next);
      return;
    }
    // Backend: apaga o link existente desta conta (1:1) e insere o novo
    await supabase.from("account_site_links").delete().eq("google_account_id", googleAccountId);
    await supabase.from("account_site_links").insert({
      user_id: user.id, google_account_id: googleAccountId, site_id: siteId,
    });
    await refresh();
  };

  const removeLink = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      const next = store.links.filter((l) => l.id !== id);
      saveGuestStore({ ...store, links: next });
      setLinks(next);
      return;
    }
    await supabase.from("account_site_links").delete().eq("id", id);
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
    googleAccounts,
    gamAccounts,
    sites,
    links,
    loading,
    refresh,
    lastSyncedAt,
    isGuest: !user,
    saveRules,
    acknowledgeAlert,
    queueAction,
    insertSampleData,
    persistEngineAlerts,
    addGoogleAccount,
    removeGoogleAccount,
    addGamAccount,
    removeGamAccount,
    addSite,
    removeSite,
    addLink,
    removeLink,
  };
}
