import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useDashboardFilters } from "@/contexts/FilterContext";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabasePagination";
import type { DataReadiness, EngineAlertDraft } from "@/engine/rules";
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
  // Readiness signal derived from sync_state. Used by the rules engine to suppress
  // false -100% ROI alerts while GAM revenue is still consolidating.
  dataReadiness: DataReadiness;
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
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";

export const DASHBOARD_QK = ["dashboard"] as const;

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
  auto_analysis_days: 15,
  auto_stoploss_days: 7,
  auto_stoploss_min_roi: -20,
  auto_stoploss_min_cost: 0,
  auto_scale_min_roi: 30,
  auto_scale_budget_pct: 20,
  auto_scale_interval_days: 3,
  auto_cpa_up_pct: 10,
  auto_cpa_down_pct: 10,
  auto_cpa_review_days: 3,
  auto_standby_enter_days: 7,
  auto_standby_max_days: 14,
  auto_standby_roi_low: 1,
  auto_standby_roi_high: 10,
  auto_standby_exit_roi: 10,
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

interface DashboardSnapshot {
  campaigns: Campaign[];
  metrics: DailyMetric[];
  placements: Placement[];
  rules: RulesConfig | null;
  alerts: DomainAlert[];
  googleAccounts: GoogleAccount[];
  gamAccounts: GamAccount[];
  sites: Site[];
  links: AccountSiteLink[];
  dataReadiness: DataReadiness;
  fetchedAt: number;
}

// Guests have no sync_state — they're using local sample data.
const GUEST_READINESS: DataReadiness = { isReady: true, gamMinutesSinceSuccess: null };

// Threshold for considering the GAM sync stale. GAM data typically takes 1–6h
// to consolidate; we treat anything older than 6h as stale → suppress false
// -100% ROI alerts. Tunable here; could later move to rules_config.
const GAM_FRESHNESS_MINUTES = 360;

// Fetch window: we deliberately fetch a fixed broad window (last N days) on
// every dashboard load, regardless of the user's current date filter. Date
// range NARROWING happens client-side in the Index.tsx `filtered` useMemo,
// so switching between Hoje / Ontem / Últimos 7 / 15 / 30 dias is INSTANT —
// no server round-trip, no React Query refetch.
// 60 covers every UI preset comfortably. If the user picks a custom range
// earlier than today-60d, the client filter returns empty; the manual
// "Atualizar" button forces a fresh fetch.
const FETCH_WINDOW_DAYS = 60;

const isoDate = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const makeFetchRange = (): { from: string; to: string } => {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - FETCH_WINDOW_DAYS);
  return { from: isoDate(from), to: isoDate(to) };
};

interface SyncStateRow {
  source: string;
  last_status: string;
  last_finished_at: string | null;
  last_error: string | null;
}

const computeReadiness = (rows: SyncStateRow[]): DataReadiness => {
  // Pick the most recent GAM sync row (sources include "gam-sync-revenue",
  // "gam-sync-historical", etc.). We use whichever finished most recently.
  const gamRows = rows
    .filter((r) => r.source?.toLowerCase().includes("gam"))
    .sort((a, b) => {
      const ta = a.last_finished_at ? new Date(a.last_finished_at).getTime() : 0;
      const tb = b.last_finished_at ? new Date(b.last_finished_at).getTime() : 0;
      return tb - ta;
    });
  const gam = gamRows[0];

  if (!gam) {
    // No sync state at all — fresh user or demo. Don't suppress; let alerts through.
    return { isReady: true, reason: "no_sync_state", gamMinutesSinceSuccess: null };
  }

  const status = (gam.last_status ?? "").toLowerCase();
  if (status === "error" || status === "failed") {
    return { isReady: false, reason: "gam_failed", gamMinutesSinceSuccess: null };
  }

  if (!gam.last_finished_at) {
    return { isReady: false, reason: "gam_stale", gamMinutesSinceSuccess: null };
  }

  const minutesSince = Math.round(
    (Date.now() - new Date(gam.last_finished_at).getTime()) / 60_000,
  );

  if (minutesSince > GAM_FRESHNESS_MINUTES) {
    return { isReady: false, reason: "gam_stale", gamMinutesSinceSuccess: minutesSince };
  }

  return { isReady: true, gamMinutesSinceSuccess: minutesSince };
};

const emptySnapshot = (): DashboardSnapshot => ({
  campaigns: [],
  metrics: [],
  placements: [],
  rules: null,
  alerts: [],
  googleAccounts: [],
  gamAccounts: [],
  sites: [],
  links: [],
  dataReadiness: GUEST_READINESS,
  fetchedAt: 0,
});

export function useDashboardData(): DashboardData {
  const { user, loading: authLoading } = useAuth();
  // `range` (date filter) is not destructured here anymore: it now affects
  // only the client-side narrowing in Index.tsx, not the server fetch.
  const { filters } = useDashboardFilters();
  const queryClient = useQueryClient();
  const isGuest = !user;

  // queryKey deliberately does NOT include the user's date filter (range.*).
  // We always fetch the broad FETCH_WINDOW_DAYS window so that date-preset
  // switches are served from cache. Account/site filters do change the result
  // set materially, so they stay in the key.
  const queryKey = useMemo(
    () => [...DASHBOARD_QK, user?.id ?? "guest", filters.googleAccountIds.join("|"), filters.siteId],
    [user?.id, filters.googleAccountIds, filters.siteId],
  );

  const fetchAll = useCallback(async (): Promise<DashboardSnapshot> => {
    const fetchRange = makeFetchRange();
    if (import.meta.env.DEV) console.info("[useQuery] dashboard fetch", { queryKey, from: fetchRange.from, to: fetchRange.to, windowDays: FETCH_WINDOW_DAYS });

    if (!user) {
      const store = loadGuestStore();
      return { ...store, dataReadiness: GUEST_READINESS, fetchedAt: Date.now() };
    }

    // ISOLAMENTO POR SITE: quando há site selecionado, derivamos as contas Ads
    // vinculadas a ele a partir de account_site_links e usamos isso para filtrar
    // campanhas e métricas — independentemente do filters.googleAccountIds (que
    // pode estar vazio em first paint enquanto o site vem do localStorage).
    const siteFilterActive = !!filters.siteId && filters.siteId !== "all";
    let siteAccountIds: string[] = [];
    if (siteFilterActive) {
      const { data: linkRows } = await supabase
        .from("account_site_links")
        .select("google_account_id")
        .eq("site_id", filters.siteId);
      siteAccountIds = (linkRows ?? []).map((r: any) => r.google_account_id).filter(Boolean);
    }

    // Combina filtro manual de contas com as contas vinculadas ao site
    const manualAccountIds = filters.googleAccountIds;
    let effectiveAccountIds: string[] | null = null;
    if (siteFilterActive && manualAccountIds.length > 0) {
      effectiveAccountIds = manualAccountIds.filter((id) => siteAccountIds.includes(id));
    } else if (siteFilterActive) {
      effectiveAccountIds = siteAccountIds;
    } else if (manualAccountIds.length > 0) {
      effectiveAccountIds = manualAccountIds;
    }

    if (import.meta.env.DEV) {
      console.info("[dashboard] site isolation", {
        siteId: filters.siteId, siteAccountIds, manualAccountIds, effectiveAccountIds,
      });
    }

    const applyAccountFilter = <T extends { eq: (column: string, value: string) => T; in: (column: string, values: string[]) => T }>(q: T): T => {
      if (!effectiveAccountIds) return q;
      // Se filtro de site retornou zero contas, não mostramos nada (em vez de tudo)
      if (effectiveAccountIds.length === 0) return q.eq("google_account_id", EMPTY_UUID);
      return q.in("google_account_id", effectiveAccountIds);
    };

    const buildMetricsQuery = () => applyAccountFilter(
      supabase
        .from("daily_metrics")
        .select("*")
        .gte("date", fetchRange.from)
        .lte("date", fetchRange.to),
    ).order("date", { ascending: false });

    const buildCampaignsQuery = () => applyAccountFilter(
      supabase.from("campaigns").select("*"),
    ).order("name");

    const buildPlacementsQuery = () => {
      let q = supabase.from("placements").select("*")
        .gte("date", fetchRange.from)
        .lte("date", fetchRange.to)
        .order("date", { ascending: false });
      if (siteFilterActive) q = q.eq("site_id", filters.siteId);
      return q;
    };

    const [c, m, p, r, a, ga, gam, s, l, syncSt] = await Promise.all([
      fetchAllRows<Campaign>(() => buildCampaignsQuery()),
      fetchAllRows<DailyMetric>(() => buildMetricsQuery()),
      fetchAllRows<Placement>(() => buildPlacementsQuery()),
      supabase.from("rules_config").select("*").maybeSingle(),
      supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("google_accounts").select("*").order("account_name"),
      supabase.from("gam_accounts").select("*").order("account_name"),
      supabase.from("sites").select("*").order("name"),
      supabase.from("account_site_links").select("*"),
      supabase
        .from("sync_state")
        .select("source, last_status, last_finished_at, last_error")
        .order("last_finished_at", { ascending: false }),
    ]);

    return {
      campaigns: c as Campaign[],
      metrics: m as DailyMetric[],
      placements: p as Placement[],
      rules: (r.data as RulesConfig) ?? ({ ...RULES_DEFAULT, user_id: user.id } as RulesConfig),
      alerts: (a.data ?? []) as DomainAlert[],
      googleAccounts: (ga.data ?? []) as GoogleAccount[],
      gamAccounts: (gam.data ?? []) as GamAccount[],
      sites: (s.data ?? []) as Site[],
      links: (l.data ?? []) as AccountSiteLink[],
      dataReadiness: computeReadiness((syncSt.data ?? []) as SyncStateRow[]),
      fetchedAt: Date.now(),
    };
  }, [user, queryKey, filters.googleAccountIds, filters.siteId]);

  const query = useQuery<DashboardSnapshot>({
    queryKey,
    queryFn: fetchAll,
    enabled: !authLoading,
    staleTime: 30_000,
    placeholderData: emptySnapshot(),
  });

  const snap = query.data ?? emptySnapshot();

  // Mantém o snapshot local de regras para que saveRules tenha fallback otimista
  const [rulesLocalOverride] = useState<RulesConfig | null>(null);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: DASHBOARD_QK });
  }, [queryClient]);

  const saveRules = async (nextRules: RulesConfig) => {
    if (!user) {
      const store = loadGuestStore();
      const next = { ...nextRules, user_id: GUEST_USER_ID };
      saveGuestStore({ ...store, rules: next });
      await refresh();
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
      await refresh();
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
    const store = createSampleStore(user?.id ?? GUEST_USER_ID, snap.rules ?? RULES_DEFAULT);
    if (!user) {
      saveGuestStore(store);
      await refresh();
      return;
    }
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
      await refresh();
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
      const created: GoogleAccount = { id: uid(), user_id: GUEST_USER_ID, ...row } as GoogleAccount;
      saveGuestStore({ ...store, googleAccounts: [...store.googleAccounts, created] });
      await refresh();
      return;
    }
    await supabase.from("google_accounts").insert({ ...row, user_id: user.id });
    await refresh();
  };

  const removeGoogleAccount = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      saveGuestStore({
        ...store,
        googleAccounts: store.googleAccounts.filter((a) => a.id !== id),
        links: store.links.filter((l) => l.google_account_id !== id),
      });
      await refresh();
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
      await refresh();
      return;
    }
    await supabase.from("gam_accounts").insert({ ...row, user_id: user.id });
    await refresh();
  };

  const removeGamAccount = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      saveGuestStore({ ...store, gamAccounts: store.gamAccounts.filter((a) => a.id !== id) });
      await refresh();
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
      await refresh();
      return;
    }
    await supabase.from("sites").insert({ ...row, user_id: user.id });
    await refresh();
  };

  const removeSite = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      saveGuestStore({
        ...store,
        sites: store.sites.filter((s) => s.id !== id),
        links: store.links.filter((l) => l.site_id !== id),
      });
      await refresh();
      return;
    }
    await supabase.from("account_site_links").delete().eq("site_id", id);
    await supabase.from("sites").delete().eq("id", id);
    await refresh();
  };

  const addLink = async (googleAccountId: string, siteId: string) => {
    if (!user) {
      const store = loadGuestStore();
      const filtered = store.links.filter((l) => l.google_account_id !== googleAccountId);
      const created: AccountSiteLink = {
        id: uid(), user_id: GUEST_USER_ID,
        google_account_id: googleAccountId, site_id: siteId,
      };
      saveGuestStore({ ...store, links: [...filtered, created] });
      await refresh();
      return;
    }
    await supabase.from("account_site_links").delete().eq("google_account_id", googleAccountId);
    await supabase.from("account_site_links").insert({
      user_id: user.id, google_account_id: googleAccountId, site_id: siteId,
    });
    await refresh();
  };

  const removeLink = async (id: string) => {
    if (!user) {
      const store = loadGuestStore();
      saveGuestStore({ ...store, links: store.links.filter((l) => l.id !== id) });
      await refresh();
      return;
    }
    await supabase.from("account_site_links").delete().eq("id", id);
    await refresh();
  };

  return {
    campaigns: snap.campaigns,
    metrics: snap.metrics,
    placements: snap.placements,
    rules: rulesLocalOverride ?? snap.rules,
    alerts: snap.alerts,
    googleAccounts: snap.googleAccounts,
    gamAccounts: snap.gamAccounts,
    sites: snap.sites,
    links: snap.links,
    loading: query.isLoading || query.isFetching,
    refresh,
    lastSyncedAt: snap.fetchedAt ? new Date(snap.fetchedAt) : null,
    dataReadiness: snap.dataReadiness,
    isGuest,
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
