import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BarChart3, DollarSign, Plus, RefreshCw, TrendingDown,
  TrendingUp, Wallet, Settings, Plug, LayoutDashboard, MapPin, Repeat, Globe, Bot, Sparkles, CalendarDays, Rocket, History, UserCog, Menu,
} from "lucide-react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useDashboardData } from "@/hooks/useDashboardData";
import { evaluate } from "@/engine/rules";
import { fmtCurrency, fmtUSD, fmtPercent } from "@/lib/format";
import { DashboardErrorBoundary } from "@/components/dashboard/DashboardErrorBoundary";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { CampaignsRanking, PlacementsRanking } from "@/components/dashboard/Rankings";
import { RoiChart } from "@/components/dashboard/RoiChart";
import { CampaignsTable } from "@/components/dashboard/CampaignsTable";
import { RulesPanel } from "@/components/dashboard/RulesPanel";
import { IntegrationsPanel } from "@/components/dashboard/IntegrationsPanel";
import { FilterBar, presetFromRange, type DashboardFilters } from "@/components/dashboard/FilterBar";
import { GlobalSiteSelector } from "@/components/dashboard/GlobalSiteSelector";
import { FilterProvider, useDashboardFilters } from "@/contexts/FilterContext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SegmentTabs } from "@/components/dashboard/SegmentTabs";
import { PlacementsTab } from "@/components/dashboard/PlacementsTab";
import { PlacementFunnelTab } from "@/components/dashboard/PlacementFunnelTab";
import { SmartFunnelPanel } from "@/components/dashboard/SmartFunnelPanel";
import { RetentionTab } from "@/components/dashboard/RetentionTab";
import { CountriesTab } from "@/components/dashboard/CountriesTab";
import { CreativesTab } from "@/components/dashboard/CreativesTab";
import { AutomationTab } from "@/components/dashboard/AutomationTab";
import { ScaleUnlockTab } from "@/components/dashboard/ScaleUnlockTab";
import { MigrationTab } from "@/components/dashboard/MigrationTab";
import { FinancialCalendarTab } from "@/components/dashboard/FinancialCalendarTab";
import { HistoryTab } from "@/components/dashboard/HistoryTab";
import { SiteSyncBanner } from "@/components/dashboard/SiteSyncBanner";

import { useAllSitesOnboarding } from "@/hooks/useAllSitesOnboarding";
import type { Campaign, DailyMetric, Placement } from "@/types/domain";
import { NET_FACTOR, REV_SHARE_PCT } from "@/engine/rules";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRows } from "@/lib/supabasePagination";

const toLocalISODate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const isTodayOnlyRange = (from: string, to: string) => {
  const today = toLocalISODate(new Date());
  return from === today && to === today;
};

const Index = () => {
  return (
    <FilterProvider>
      <IndexInner />
    </FilterProvider>
  );
};

const IndexInner = () => {
  const { user } = useAuth();
  const { data: currentRole } = useCurrentRole();
  const data = useDashboardData();
  const queryClient = useQueryClient();
  const [evaluating, setEvaluating] = useState(false);
  const { filters, setFilters, range } = useDashboardFilters();
  const [showDebug, setShowDebug] = useState(false);
  const allSites = useAllSitesOnboarding(!!user);
  const selectedSite = filters.siteId !== "all"
    ? data.sites.find((s) => s.id === filters.siteId)
    : null;
  const linkedAccountIdsForSelectedSite = useMemo(
    () => filters.siteId === "all"
      ? []
      : data.links.filter((l) => l.site_id === filters.siteId).map((l) => l.google_account_id),
    [data.links, filters.siteId],
  );
  const accountSelectionCoversSelectedSite = filters.siteId !== "all"
    && linkedAccountIdsForSelectedSite.length > 0
    && filters.googleAccountIds.length === linkedAccountIdsForSelectedSite.length
    && linkedAccountIdsForSelectedSite.every((id) => filters.googleAccountIds.includes(id));
  const accountFilterIsRestrictive = filters.googleAccountIds.length > 0
    && !(filters.siteId !== "all" && accountSelectionCoversSelectedSite);
  const campaignFilterIsRestrictive = filters.campaignId !== "all";
  const canUseRealGamTotals = !accountFilterIsRestrictive && !campaignFilterIsRestrictive;
  const selectedSiteUsesSharedAccounts = useMemo(() => {
    if (filters.siteId === "all") return false;
    const countsByAccount = new Map<string, number>();
    for (const l of data.links) {
      countsByAccount.set(l.google_account_id, (countsByAccount.get(l.google_account_id) ?? 0) + 1);
    }
    return linkedAccountIdsForSelectedSite.some((id) => (countsByAccount.get(id) ?? 0) > 1);
  }, [data.links, filters.siteId, linkedAccountIdsForSelectedSite]);

  const fxQuery = useQuery<{ rate: number; updatedAt: string | null; source: string | null }>({
    queryKey: ["fx-usd-brl"],
    queryFn: async () => {
      // 1) Tenta a tabela exchange_rates (atualizada 1x/dia via fx-sync)
      try {
        const { data } = await supabase
          .from("exchange_rates")
          .select("rate, updated_at, source")
          .eq("from_currency", "USD")
          .eq("to_currency", "BRL")
          .maybeSingle();
        const dbRate = Number((data as any)?.rate);
        const dbAt = (data as any)?.updated_at as string | null;
        const fresh = dbAt ? (Date.now() - new Date(dbAt).getTime()) < 24 * 60 * 60 * 1000 : false;
        if (Number.isFinite(dbRate) && dbRate > 0 && fresh) {
          return { rate: dbRate, updatedAt: dbAt, source: (data as any)?.source ?? "exchange_rates" };
        }
        // Tabela existe mas está velha: tenta refresh via edge function
        try { await supabase.functions.invoke("fx-sync"); } catch {}
        const { data: data2 } = await supabase
          .from("exchange_rates")
          .select("rate, updated_at, source")
          .eq("from_currency", "USD")
          .eq("to_currency", "BRL")
          .maybeSingle();
        const r2 = Number((data2 as any)?.rate);
        if (Number.isFinite(r2) && r2 > 0) {
          return { rate: r2, updatedAt: (data2 as any)?.updated_at ?? null, source: (data2 as any)?.source ?? "fx-sync" };
        }
      } catch {}
      // 2) Fallback direto na awesomeapi (BCB)
      try {
        const r = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL");
        const j = await r.json();
        const rate = Number(j?.USDBRL?.bid);
        if (Number.isFinite(rate) && rate > 0) {
          return { rate, updatedAt: new Date().toISOString(), source: "awesomeapi" };
        }
      } catch {}
      // 3) Último fallback: open.er-api
      try {
        const r = await fetch("https://open.er-api.com/v6/latest/USD");
        const j = await r.json();
        const rate = Number(j?.rates?.BRL);
        if (Number.isFinite(rate) && rate > 0) {
          return { rate, updatedAt: new Date().toISOString(), source: "open.er-api" };
        }
      } catch {}
      return { rate: 5, updatedAt: null, source: "fallback" };
    },
    staleTime: 30 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });

  // Receita extra (push + outras origens) vinda do GAM por UTM, para somar ao ROI/ROAS.
  // Usa somente o que o GAM marca explicitamente como utm_source=push; não estima por residual.
  const extraRevQuery = useQuery({
    queryKey: ["extra-revenue", range.from, range.to, filters.siteId, filters.googleAccountIds.join("|")],
    queryFn: async () => {
      const rows = await fetchAllRows<any>(() => {
        let q = supabase
          .from("gam_campaign_source_revenue")
          .select("id, utm_source, revenue_usd, date")
          .gte("date", range.from)
          .lte("date", range.to);
        if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
        return q.order("date", { ascending: true }).order("id", { ascending: true });
      });
      let push = 0, other = 0;
      for (const r of rows ?? []) {
        const usd = Number((r as any).revenue_usd) || 0;
        const src = String((r as any).utm_source ?? "").toLowerCase();
        if (src === "google") continue;
        if (src === "push") push += usd; else other += usd;
      }
      return { push, other };
    },
    staleTime: 30_000,
  });

  // Google Ads: usa o updated_at do banco (último sync)
  const adsFreshnessQuery = useQuery({
    queryKey: ["ads-freshness", filters.googleAccountIds.join("|")],
    queryFn: async () => {
      let adsQ = supabase
        .from("daily_metrics")
        .select("updated_at")
        .order("updated_at", { ascending: false })
        .limit(1);
      if (filters.googleAccountIds.length > 0) adsQ = adsQ.in("google_account_id", filters.googleAccountIds);
      const { data } = await adsQ;
      return data?.[0]?.updated_at ?? null;
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  // GAM: usa apenas o banco local para frescor. Evita chamar relatório GAM ao trocar abas/sites,
  // porque a API externa pode ficar >150s e derrubar a função com 504.
  const gamFreshnessQuery = useQuery({
    queryKey: ["gam-freshness", filters.siteId],
    queryFn: async () => {
      let q = supabase
        .from("site_metrics_daily")
        .select("date, updated_at")
        .order("date", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(1);
      if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
      const { data, error } = await q;
      if (error) throw error;
      const row = data?.[0] as { date?: string; updated_at?: string } | undefined;
      return row?.date
        ? { date: row.date, label: `Ad Manager salvo até: ${row.date}`, updatedAt: row.updated_at ?? null }
        : { date: null, label: "Ad Manager: sem dados salvos", updatedAt: null };
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Viewability + eCPM por site (GAM)
  // IMPORTANTE: incluímos "hoje" no range (alguns presets como "Últimos 7 dias" param em ontem),
  // pois a sync do GAM grava o dia corrente também.
  const siteMetricsQuery = useQuery({
    queryKey: ["site-metrics-daily", filters.siteId, range.from, range.to],
    queryFn: async () => {
      const rows = await fetchAllRows<any>(() => {
        let q = supabase
          .from("site_metrics_daily")
          .select("date, impressions, measurable_impressions, viewable_impressions, revenue_native, currency, ecpm_native")
          .gte("date", range.from).lte("date", range.to);
        if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
        return q.order("date", { ascending: false }).order("id", { ascending: true });
      });

      if (import.meta.env.DEV) {
        console.info("[site-metrics-daily] rows", { siteId: filters.siteId, from: range.from, to: range.to, count: rows.length, sample: rows[0] });
      }
      const fxForMetrics = fxQuery.data?.rate ?? 5;
      const totals = rows.reduce((a, r: any) => {
        const currency = String(r.currency || "USD").toUpperCase();
        const nativeRevenue = Number(r.revenue_native ?? 0);
        const comparableRevenue = filters.siteId === "all" && currency === "BRL"
          ? nativeRevenue / fxForMetrics
          : nativeRevenue;
        return {
          impr: a.impr + Number(r.impressions ?? 0),
          meas: a.meas + Number(r.measurable_impressions ?? 0),
          view: a.view + Number(r.viewable_impressions ?? 0),
          rev: a.rev + comparableRevenue,
          currency: r.currency || a.currency,
        };
      }, { impr: 0, meas: 0, view: 0, rev: 0, currency: "USD" });
      const viewability = totals.meas > 0 ? (totals.view / totals.meas) * 100 : 0;
      const ecpmNative = totals.impr > 0 ? (totals.rev / totals.impr) * 1000 : 0;
      return { viewability, ecpmNative, currency: filters.siteId === "all" ? "GAM" : totals.currency, impressions: totals.impr, effectiveDate: null as string | null };
    },
    staleTime: 30_000,
    refetchInterval: 2 * 60_000,
  });


  // Receita REAL do GAM no range exato (sem ampliar lookback). Usado pra mostrar o total verdadeiro
  // do Ad Manager no card "Receita", mesmo quando parte das impressões não foi atribuída via UTM.
  const siteRealRevenueQuery = useQuery<{ byCurrency: Record<string, number>; impressions: number; effectiveDate: string | null }>({
    queryKey: ["site-real-revenue", filters.siteId, filters.googleAccountIds.join("|"), filters.campaignId, range.from, range.to],
    queryFn: async () => {
      let effectiveDate: string | null = null;
      let rows = await fetchAllRows<any>(() => {
        let q = supabase.from("site_metrics_daily")
          .select("id, date, revenue_native, currency, impressions, site_id")
          .gte("date", range.from).lte("date", range.to);
        if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
        return q.order("date", { ascending: true }).order("id", { ascending: true });
      });

      if (rows.length === 0 && isTodayOnlyRange(range.from, range.to)) {
        let latestQ = supabase
          .from("site_metrics_daily")
          .select("date")
          .lte("date", range.to)
          .order("date", { ascending: false })
          .limit(1);
        if (filters.siteId !== "all") latestQ = latestQ.eq("site_id", filters.siteId);
        const { data: latestRows } = await latestQ;
        effectiveDate = latestRows?.[0]?.date ?? null;
        if (effectiveDate) {
          rows = await fetchAllRows<any>(() => {
            let q = supabase.from("site_metrics_daily")
              .select("id, date, revenue_native, currency, impressions, site_id")
              .eq("date", effectiveDate!);
            if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
            return q.order("date", { ascending: true }).order("id", { ascending: true });
          });
        }
      }

      const totals = rows.reduce((a, r: any) => {
        const cur = String(r.currency || "USD").toUpperCase();
        a.byCurrency[cur] = (a.byCurrency[cur] ?? 0) + Number(r.revenue_native ?? 0);
        a.impressions += Number(r.impressions ?? 0);
        return a;
      }, { byCurrency: {} as Record<string, number>, impressions: 0 });
      return { ...totals, effectiveDate };
    },
    enabled: canUseRealGamTotals,
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });
  // Atribuição por site quando uma conta Ads serve N sites:
  // shareByCampaignSite[campaign][site] = % da receita GAM canônica daquele campaign que veio do site.
  // Usado para multiplicar spend / clicks / conv quando filtros.siteId !== "all".
  const siteShareQuery = useQuery({
    queryKey: ["site-share", range.from, range.to],
    queryFn: async () => {
      const rows = await fetchAllRows<any>(() => supabase
        .from("gam_campaign_source_revenue")
        .select("id, campaign_id, site_id, revenue_usd, date")
        .eq("utm_source", "google")
        .not("site_id", "is", null)
        .neq("campaign_id", "__aggregate__")
        .gte("date", range.from).lte("date", range.to)
        .order("date", { ascending: true })
        .order("id", { ascending: true }));
      const totalByCamp = new Map<string, number>();
      const bySite = new Map<string, Map<string, number>>();
      for (const r of rows ?? []) {
        const cid = String((r as any).campaign_id);
        const sid = String((r as any).site_id);
        const v = Number((r as any).revenue_usd) || 0;
        totalByCamp.set(cid, (totalByCamp.get(cid) ?? 0) + v);
        const inner = bySite.get(cid) ?? new Map<string, number>();
        inner.set(sid, (inner.get(sid) ?? 0) + v);
        bySite.set(cid, inner);
      }
      const share = new Map<string, Map<string, number>>();
      for (const [cid, inner] of bySite) {
        const total = totalByCamp.get(cid) ?? 0;
        if (total <= 0) continue;
        const m = new Map<string, number>();
        for (const [sid, v] of inner) m.set(sid, v / total);
        share.set(cid, m);
      }
      return share;
    },
    staleTime: 60_000,
    enabled: selectedSiteUsesSharedAccounts,
  });

  // eCPM por campanha vindo do GAM no período exato.
  // Fonte canônica: gam_campaign_source_revenue filtrada por utm_source='google'.
  // Esta é a mesma agregação que o GAM expõe quando consultamos por utm_campaign
  // (cruzamento oficial Google Ads campaign.id ↔ GAM utm_campaign).
  // gam_placement_revenue é placement-level e pode diferir levemente do total por campanha,
  // por isso usamos a fonte canônica por source para o eCPM da tabela principal.
  const campaignGamMetricsQuery = useQuery({
    queryKey: ["campaign-gam-metrics", filters.siteId, range.from, range.to, filters.googleAccountIds.join("|")],
    queryFn: async () => {
      const rows = await fetchAllRows<any>(() => {
        let q = supabase
          .from("gam_campaign_source_revenue")
          .select("id, campaign_id, revenue_usd, impressions, site_id, date")
          .eq("utm_source", "google")
          .gte("date", range.from)
          .lte("date", range.to);
        if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
        return q.order("date", { ascending: true }).order("id", { ascending: true });
      });

      const selectedAccountIds = new Set(filters.googleAccountIds);
      const allowedCampaignIds = selectedAccountIds.size > 0
        ? new Set(data.campaigns
          .filter((c) => c.google_account_id && selectedAccountIds.has(c.google_account_id))
          .map((c) => c.campaign_id))
        : null;

      const map = new Map<string, { revenueUsd: number; impressions: number }>();
      for (const r of rows) {
        const cid = String((r as any).campaign_id ?? "");
        if (!cid || cid === "__aggregate__") continue;
        if (allowedCampaignIds && !allowedCampaignIds.has(cid)) continue;
        const cur = map.get(cid) ?? { revenueUsd: 0, impressions: 0 };
        cur.revenueUsd += Number((r as any).revenue_usd ?? 0);
        cur.impressions += Number((r as any).impressions ?? 0);
        map.set(cid, cur);
      }
      const out = new Map<string, { ecpm: number; impressions: number; revenueUsd: number }>();
      for (const [cid, v] of map) {
        out.set(cid, {
          ecpm: v.impressions > 0 ? (v.revenueUsd / v.impressions) * 1000 : 0,
          impressions: v.impressions,
          revenueUsd: v.revenueUsd,
        });
      }
      return out;
    },
    staleTime: 30_000,
    refetchInterval: 2 * 60_000,
  });

  // Taxa de correspondência (Match Rate) por campanha:
  //   AD_SERVER_IMPRESSIONS / AD_SERVER_TOTAL_REQUESTS, ambos filtrados por utm_campaign=cid.
  // Fonte: gam_campaign_source_revenue (linhas utm_source='google') no período exato.
  const campaignMatchRateQuery = useQuery({
    queryKey: ["campaign-match-rate", filters.siteId, range.from, range.to, filters.googleAccountIds.join("|")],
    queryFn: async () => {
      const rows = await fetchAllRows<any>(() => {
        let q = supabase
          .from("gam_campaign_source_revenue")
          .select("id, campaign_id, impressions, total_requests, match_rate_pct, site_id, date")
          .eq("utm_source", "google")
          .gte("date", range.from)
          .lte("date", range.to);
        if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
        return q.order("date", { ascending: true }).order("id", { ascending: true });
      });
      const selectedAccountIds = new Set(filters.googleAccountIds);
      const allowedCampaignIds = selectedAccountIds.size > 0
        ? new Set(data.campaigns
          .filter((c) => c.google_account_id && selectedAccountIds.has(c.google_account_id))
          .map((c) => c.campaign_id))
        : null;
      // Agregação por campanha usando média ponderada do match_rate_pct canônico do GAM:
      //   rate = Σ(rate_i * impressions_i) / Σ(impressions_i)
      // Quando match_rate_pct não está disponível, fallback para Σ impr / Σ requests.
      const map = new Map<string, {
        impressions: number;
        totalRequests: number;
        ratedImpressions: number;
        weightedRateSum: number;
      }>();
      for (const r of rows) {
        const cid = String((r as any).campaign_id ?? "");
        if (!cid || allowedCampaignIds && !allowedCampaignIds.has(cid)) continue;
        const impressions = Number((r as any).impressions ?? 0);
        const totalRequests = Number((r as any).total_requests ?? 0);
        const exactRatePct = Number((r as any).match_rate_pct ?? 0);
        const cur = map.get(cid) ?? { impressions: 0, totalRequests: 0, ratedImpressions: 0, weightedRateSum: 0 };
        cur.impressions += impressions;
        cur.totalRequests += totalRequests;
        if (impressions > 0 && exactRatePct > 0) {
          cur.ratedImpressions += impressions;
          cur.weightedRateSum += exactRatePct * impressions;
        }
        map.set(cid, cur);
      }
      const out = new Map<string, { matchRate: number; impressions: number; totalRequests: number }>();
      for (const [cid, v] of map) {
        if (v.ratedImpressions > 0) {
          const rate = v.weightedRateSum / v.ratedImpressions;
          out.set(cid, {
            matchRate: rate,
            impressions: v.impressions,
            totalRequests: v.totalRequests > 0 ? v.totalRequests : Math.round(v.ratedImpressions / (rate / 100)),
          });
        } else if (v.totalRequests > 0) {
          out.set(cid, {
            matchRate: (v.impressions / v.totalRequests) * 100,
            impressions: v.impressions,
            totalRequests: v.totalRequests,
          });
        } else {
          out.set(cid, { matchRate: 0, impressions: v.impressions, totalRequests: 0 });
        }
      }
      return out;
    },
    staleTime: 30_000,
    refetchInterval: 2 * 60_000,
  });

  // Auto-trigger GAM sync se a Taxa de Correspondência está vazia para o site/período atual.
  // Roda no máximo 1x por sessão+site+intervalo (controlado via sessionStorage).
  const matchRateAutoSyncRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const map = campaignMatchRateQuery.data;
    if (!map || campaignMatchRateQuery.isLoading) return;
    const expectedCampaigns = new Set<string>();
    for (const [cid, v] of campaignGamMetricsQuery.data ?? new Map()) {
      if ((v?.impressions ?? 0) > 0) expectedCampaigns.add(cid);
    }
    let campaignsWithRequests = 0;
    for (const [cid, v] of map) {
      if (v.totalRequests > 0 && (!expectedCampaigns.size || expectedCampaigns.has(cid))) campaignsWithRequests++;
    }
    let totalImpressions = 0;
    let totalRequests = 0;
    for (const v of map.values()) {
      totalImpressions += Number(v.impressions ?? 0);
      totalRequests += Number(v.totalRequests ?? 0);
    }
    const expected = expectedCampaigns.size;
    if (expected > 0 && campaignsWithRequests >= Math.ceil(expected * 0.95) && totalRequests >= totalImpressions * 0.9) return;
    if (expected === 0 && campaignsWithRequests > 0) return;
    const key = `gam-auto-sync-v4:${filters.siteId}:${range.from}:${range.to}`;
    if (matchRateAutoSyncRef.current.has(key)) return;
    try { if (sessionStorage.getItem(key)) return; } catch { /* ignore */ }
    matchRateAutoSyncRef.current.add(key);
    try { sessionStorage.setItem(key, "1"); } catch { /* ignore */ }
    (async () => {
      try {
        await supabase.functions.invoke("gam-sync-revenue", {
          body: {
            from: range.from,
            to: range.to,
            site_id: filters.siteId !== "all" ? filters.siteId : undefined,
            total_requests_only: true,
            skip_viewability: true,
            skip_snapshot_regen: true,
            sync: true,
          },
        });
        // refresca as queries para puxar os novos total_requests/eCPM
        campaignMatchRateQuery.refetch();
        campaignGamMetricsQuery.refetch();
      } catch (e) {
        console.warn("[gam-auto-sync] falhou", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignMatchRateQuery.data, campaignMatchRateQuery.isLoading, campaignGamMetricsQuery.data, filters.siteId, range.from, range.to]);

  // Melhor Match (últimos 10 dias, ignorando o range do filtro).
  // Fonte: gam_campaign_source_revenue (utm_source='google'), respeitando o site selecionado.
  const campaignBestMatchQuery = useQuery({
    queryKey: ["campaign-best-match-10d", filters.siteId, filters.googleAccountIds.join("|")],
    queryFn: async () => {
      // Mesma janela que o modal Histórico usa (BEST_MATCH_WINDOW_DAYS = 10 → últimos 10 dias, hoje incluído)
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setUTCDate(fromDate.getUTCDate() - 9);
      const from = fromDate.toISOString().slice(0, 10);
      const to = toDate.toISOString().slice(0, 10);
      let q = supabase
        .from("gam_campaign_source_revenue")
        .select("campaign_id, date, impressions, total_requests, match_rate_pct, site_id")
        .eq("utm_source", "google")
        .gte("date", from)
        .lte("date", to)
        .limit(100000);
      if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
      const { data: rows, error } = await q;
      if (error) throw error;

      const selectedAccountIds = new Set(filters.googleAccountIds);
      const allowedCampaignIds = selectedAccountIds.size > 0
        ? new Set(data.campaigns
          .filter((c) => c.google_account_id && selectedAccountIds.has(c.google_account_id))
          .map((c) => c.campaign_id))
        : null;

      const byCampaign = new Map<string, Array<{ date: string; impressions: number; total_requests: number; match_rate_pct: number | null }>>();
      for (const r of rows ?? []) {
        const cid = String((r as any).campaign_id ?? "");
        if (!cid) continue;
        if (allowedCampaignIds && !allowedCampaignIds.has(cid)) continue;
        const arr = byCampaign.get(cid) ?? [];
        arr.push({
          date: String((r as any).date),
          impressions: Number((r as any).impressions ?? 0),
          total_requests: Number((r as any).total_requests ?? 0),
          match_rate_pct: (r as any).match_rate_pct == null ? null : Number((r as any).match_rate_pct),
        });
        byCampaign.set(cid, arr);
      }
      const { buildBestMatch } = await import("@/lib/bestMatch");
      const out = new Map<string, ReturnType<typeof buildBestMatch>>();
      for (const [cid, rawRows] of byCampaign) out.set(cid, buildBestMatch(rawRows));
      return out;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Aplica filtros aos dados crus antes de mandar para a engine
  const filtered = useMemo(() => {
    const selectedAccountIds = filters.googleAccountIds;
    const linkedAccountIds = new Set(
      filters.siteId === "all"
        ? []
        : data.links.filter((l) => l.site_id === filters.siteId).map((l) => l.google_account_id),
    );
    const matchAccount = (accountId?: string | null) =>
      selectedAccountIds.length === 0 || (accountId ? selectedAccountIds.includes(accountId) : false);
    const matchSiteAccount = (accountId?: string | null) =>
      filters.siteId === "all" || (accountId ? linkedAccountIds.has(accountId) : false);
    const matchCampaign = (cid: string, accountId?: string | null) =>
      (filters.campaignId === "all" || filters.campaignId === cid) &&
      matchAccount(accountId) && matchSiteAccount(accountId);

    const inDateRange = (date: string) =>
      (!filters.fromDate || date >= filters.fromDate) &&
      (!filters.toDate || date <= filters.toDate);

    const campaigns: Campaign[] = data.campaigns.filter((c) => matchCampaign(c.campaign_id, c.google_account_id));

    const shareMap = siteShareQuery.data;
    const siteFiltered = filters.siteId !== "all";
    const campaignShare = (cid: string): number => {
      if (!siteFiltered) return 1;
      const inner = shareMap?.get(cid);
      if (!inner || inner.size <= 1) return 1; // sem split conhecido = 100% no site selecionado
      return inner.get(filters.siteId) ?? 0;
    };

    const metricsRaw = data.metrics.filter(
      (m) => matchCampaign(m.campaign_id, m.google_account_id) && inDateRange(m.date),
    );
    const metrics: DailyMetric[] = metricsRaw.map((m) => {
      const f = campaignShare(m.campaign_id);
      if (f === 1) return m;
      return {
        ...m,
        spend: Number(m.spend) * f,
        revenue: Number(m.revenue) * f,
        profit: Number(m.profit) * f,
        clicks: Math.round(Number(m.clicks) * f),
        conversions: Number(m.conversions) * f,
        impressions: Math.round(Number(m.impressions) * f),
      };
    });

    const placements: Placement[] = data.placements.filter((p) => {
      const cidOk = filters.campaignId === "all" || p.campaign_id === filters.campaignId;
      const siteOk = filters.siteId === "all" || p.site_id === filters.siteId
        || data.sites.find((s) => s.id === filters.siteId)?.name === p.site;
      return cidOk && siteOk && inDateRange(p.date);
    });

    return { campaigns, metrics, placements };
  }, [data.campaigns, data.metrics, data.placements, data.links, data.sites, filters, siteShareQuery.data]);

  const engine = useMemo(() => {
    if (!data.rules) return null;
    return evaluate({
      campaigns: filtered.campaigns,
      metrics: filtered.metrics,
      placements: filtered.placements,
      rules: data.rules,
      dataReadiness: data.dataReadiness,
    });
  }, [filtered, data.rules, data.dataReadiness]);

  // Persiste alertas gerados pela engine (só os novos, sem duplicar por título)
  useEffect(() => {
    if (!engine) return;
    const existingTitles = new Set(data.alerts.filter((a) => !a.acknowledged).map((a) => a.title));
    const newOnes = engine.alerts.filter((a) => !existingTitles.has(a.title));
    if (newOnes.length === 0) return;

    setEvaluating(true);
    data.persistEngineAlerts(newOnes).finally(() => setEvaluating(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine?.alerts.length]);

  const [syncing, setSyncing] = useState(false);
  // Cache: evita refazer GAM/Ads sync se já foi sincronizado há < 10min com os mesmos filtros.
  // Trocas de filtro rápidas (zapping) não estouram quota; botão "Atualizar" sempre força.
  const SYNC_CACHE_MS = 10 * 60_000;
  const lastSyncRef = useRef<{ key: string; at: number } | null>(null);

  const syncDashboardData = useCallback(async (nextFilters: DashboardFilters, opts?: { force?: boolean }) => {
    const defaultRange = (() => {
      const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const d = new Date();
      d.setDate(d.getDate() - 29);
      return { from: toIso(d), to: toIso(new Date()) };
    })();
    const from = nextFilters.fromDate || defaultRange.from;
    const to = nextFilters.toDate || defaultRange.to;
    const cacheKey = `${nextFilters.siteId}|${from}|${to}|${(nextFilters.googleAccountIds ?? []).join(",")}`;
    const now = Date.now();
    if (!opts?.force && lastSyncRef.current && lastSyncRef.current.key === cacheKey && (now - lastSyncRef.current.at) < SYNC_CACHE_MS) {
      // Cache hit — usa só dados do banco (refresh leve), sem chamar GAM/Ads.
      void data.refresh();
      return;
    }

    setSyncing(true);
    try {
      if (nextFilters.siteId === "all") {
        await allSites.syncAll(true, { from, to });
      } else {
        const prevTo = (() => {
          const d = new Date(`${to}T00:00:00`);
          d.setDate(d.getDate() - 1);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        })();
        const quickFrom = from <= prevTo ? prevTo : from;
        await supabase.functions.invoke("site-auto-onboard", {
          body: { site_id: nextFilters.siteId, force: true, from: quickFrom, to, quick_only: true },
        });
        await supabase.functions.invoke("site-auto-onboard", { body: { site_id: nextFilters.siteId, force: true, from, to, skip_quick_revenue: true } });
        toast({ title: "Receita atualizada", description: "Hoje e ontem foram conferidos direto no Ad Manager; o restante continua sincronizando em segundo plano." });
      }
      lastSyncRef.current = { key: cacheKey, at: Date.now() };
      await data.refresh();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["site-metrics-daily"] }),
        queryClient.invalidateQueries({ queryKey: ["site-real-revenue"] }),
        queryClient.invalidateQueries({ queryKey: ["extra-revenue"] }),
        queryClient.invalidateQueries({ queryKey: ["campaign-gam-metrics"] }),
        queryClient.invalidateQueries({ queryKey: ["campaign-match-rate"] }),
        queryClient.invalidateQueries({ queryKey: ["gam-freshness"] }),
        queryClient.invalidateQueries({ queryKey: ["dfs"] }),
        queryClient.invalidateQueries({ queryKey: ["calendar-site-metrics"] }),
      ]);
    } catch (e: any) {
      toast({ title: "Erro na sincronização", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }, [allSites, data, queryClient]);

  const handleRefresh = async () => {
    await syncDashboardData(filters, { force: true });
  };

  const handleFilterChange = (nextFilters: DashboardFilters) => {
    setFilters(nextFilters);
    void data.refresh();
  };

  const handleAcknowledge = async (id: string) => {
    await data.acknowledgeAlert(id);
  };

  const queueAction = async (
    campaignId: string, action: "pause" | "increase_budget", reason: string,
  ) => {
    await data.queueAction(campaignId, action, reason);
    toast({
      title: action === "pause" ? "Pausa enfileirada" : "Aumento sugerido",
      description: "Ação registrada como pendente. Execução real entra na próxima fase.",
    });
  };

  const insertSampleData = async () => {
    await data.insertSampleData();
    toast({ title: "Dados de teste inseridos", description: "Inclui contas, sites e vínculos." });
  };

  const baseTotals = engine?.totals ?? { spend: 0, revenue: 0, profit: 0, roi: 0, roas: 0 };
  const usdBrl = fxQuery.data?.rate ?? 5;
  const fxUpdatedAt = fxQuery.data?.updatedAt ?? null;
  const fxSource = fxQuery.data?.source ?? null;
  const extraPushUsd = extraRevQuery.data?.push ?? 0;
  const extraOtherUsd = extraRevQuery.data?.other ?? 0;
  // O valor do GAM/API vem bruto. Para a dashboard usamos o líquido do publisher,
  // aplicando uma única vez o desconto fixo de 6,5%.
  const extraNetUsd = (extraPushUsd + extraOtherUsd) * NET_FACTOR;
  const extraNetBrl = extraNetUsd * usdBrl;

  // Receita REAL bruta do GAM em BRL (independe do display). Inclui impressões SEM UTM.
  const realGamRevenueGrossBrl = (() => {
    const byCur = siteRealRevenueQuery.data?.byCurrency ?? {};
    let total = 0;
    for (const [cur, val] of Object.entries(byCur)) {
      if (cur === "BRL") total += val;
      else total += val * usdBrl; // USD ou fallback
    }
    return total;
  })();
  const realGamRevenueNetBrl = realGamRevenueGrossBrl * NET_FACTOR;
  const hasRealGam = realGamRevenueGrossBrl > 0;
  // Se temos receita real do GAM, usamos ela como base do ROI/lucro após aplicar -6,5%.
  // Caso contrário, fallback para receita atribuída via UTM (Google) + push/outras.
  const totalProfitBrl = hasRealGam
    ? realGamRevenueNetBrl - baseTotals.spend
    : baseTotals.profit + extraNetBrl;
  const totalRevenueUsd = hasRealGam
    ? realGamRevenueNetBrl / usdBrl
    : baseTotals.revenue + extraNetUsd;
  const totalRoi = baseTotals.spend > 0 ? (totalProfitBrl / baseTotals.spend) * 100 : 0;
  const totalRoas = baseTotals.spend > 0 ? (totalProfitBrl + baseTotals.spend) / baseTotals.spend : 0;
  const totals = {
    spend: baseTotals.spend,
    revenue: totalRevenueUsd,
    profit: totalProfitBrl,
    roi: totalRoi,
    roas: totalRoas,
  };
  const profitPositive = totals.profit >= 0;
  // Site selecionado: se o GAM do site é em BRL, exibimos a receita em BRL nativo
  // (o valor armazenado é USD-equivalent: dividido por FX na ingestão; multiplicar por FX devolve o BRL original)
  const isBrlSite = String(selectedSite?.gam_currency ?? "USD").toUpperCase() === "BRL";
  const extraPushDisplay = isBrlSite ? (extraPushUsd * NET_FACTOR) * usdBrl : extraPushUsd * NET_FACTOR;
  const extraOtherDisplay = isBrlSite ? (extraOtherUsd * NET_FACTOR) * usdBrl : extraOtherUsd * NET_FACTOR;
  const fmtRevenue = (v: number) => isBrlSite ? fmtCurrency(v) : fmtUSD(v);
  // Debug: receita bruta a partir das métricas filtradas (antes do rev share)
  const grossRevenueUsd = filtered.metrics.reduce((acc, m) => acc + Number(m.revenue ?? 0), 0);
  const grossProfitBrl = filtered.metrics.reduce((acc, m) => acc + Number(m.profit ?? 0), 0);

  // Receita REAL do GAM líquida (com -6,5%), somando todas as moedas convertidas
  // para a moeda de exibição do site. Ex.: GAM total 1.871,97 → dashboard ~1.750.
  const realGamRevenueGrossDisplay = isBrlSite ? realGamRevenueGrossBrl : realGamRevenueGrossBrl / usdBrl;
  const realGamRevenueNetDisplay = isBrlSite ? realGamRevenueNetBrl : realGamRevenueNetBrl / usdBrl;
  // Receita atribuída = Google UTM + push/outras (sem impressões sem tag), líquida.
  const attributedRevenueUsd = grossRevenueUsd + extraPushUsd + extraOtherUsd;
  const attributedRevenueNetDisplay = isBrlSite ? (attributedRevenueUsd * NET_FACTOR) * usdBrl : attributedRevenueUsd * NET_FACTOR;
  const attributionPct = realGamRevenueNetDisplay > 0
    ? (attributedRevenueNetDisplay / realGamRevenueNetDisplay) * 100
    : 0;

  const TABS: Array<{ value: string; label: string; icon: typeof BarChart3 }> = [
    { value: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { value: "calendar", label: "Calendário", icon: CalendarDays },
    { value: "integrations", label: "Integrações", icon: Plug },
    { value: "placements", label: "Placements", icon: MapPin },
    { value: "funnel", label: "Funil", icon: BarChart3 },
    { value: "countries", label: "Países", icon: Globe },
    { value: "creatives", label: "Criativos", icon: Sparkles },
    { value: "retention", label: "Retenção / Push", icon: Repeat },
    { value: "automation", label: "Automação", icon: Bot },
    { value: "scale-unlock", label: "Destravar Escala", icon: Rocket },
    { value: "migration", label: "Migração", icon: Repeat },
    { value: "rules", label: "Regras", icon: Settings },
    { value: "history", label: "Histórico", icon: History },
  ];
  const [activeTab, setActiveTab] = useState("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);
  const activeTabMeta = TABS.find((t) => t.value === activeTab) ?? TABS[0];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="w-full max-w-[3440px] mx-auto px-3 sm:px-4 lg:px-6 py-3 md:py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {/* Mobile hamburger */}
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="icon" className="md:hidden h-10 w-10 shrink-0" aria-label="Abrir menu">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[86vw] max-w-[340px] p-0 flex flex-col">
                <SheetHeader className="px-4 py-4 border-b">
                  <SheetTitle className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
                      <BarChart3 className="h-4 w-4 text-primary-foreground" />
                    </div>
                    <span>UDC COMPHANY</span>
                  </SheetTitle>
                </SheetHeader>
                <nav className="flex-1 overflow-y-auto p-2">
                  {TABS.map((t) => {
                    const Icon = t.icon;
                    const active = activeTab === t.value;
                    return (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => { setActiveTab(t.value); setMenuOpen(false); }}
                        className={cn(
                          "w-full flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-left transition-colors",
                          active
                            ? "bg-gradient-primary text-primary-foreground shadow-glow"
                            : "hover:bg-accent text-foreground/80",
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{t.label}</span>
                      </button>
                    );
                  })}
                </nav>
                <div className="border-t p-3 space-y-2 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { void allSites.syncAll(true, range); setMenuOpen(false); }}
                    disabled={!allSites.totalCount || allSites.processingCount > 0}
                    className="w-full justify-start gap-2"
                  >
                    <RefreshCw className={allSites.processingCount > 0 ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    Sincronizar todos os sites
                    {allSites.processingCount > 0 && (
                      <Badge variant="secondary" className="ml-auto">
                        {allSites.processingCount}/{allSites.totalCount}
                      </Badge>
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => { handleRefresh(); setMenuOpen(false); }} disabled={syncing} className="w-full justify-start gap-2">
                    <RefreshCw className={syncing || evaluating ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    {syncing ? "Sincronizando…" : "Atualizar"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => { insertSampleData(); setMenuOpen(false); }} className="w-full justify-start gap-2">
                    <Plus className="h-4 w-4" /> Dados de teste
                  </Button>
                  {currentRole?.isSuperAdmin && (
                    <Button variant="outline" size="sm" asChild className="w-full justify-start gap-2">
                      <Link to="/admin/users" onClick={() => setMenuOpen(false)}><UserCog className="h-4 w-4" /> Admins</Link>
                    </Button>
                  )}
                  {currentRole && (
                    <div className="pt-1 text-xs text-muted-foreground truncate">
                      {data.isGuest ? "modo livre" : user?.email ?? "—"}
                    </div>
                  )}
                </div>
              </SheetContent>
            </Sheet>

            <div className="h-10 w-10 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow shrink-0">
              <BarChart3 className="h-5 w-5 text-primary-foreground" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base md:text-lg font-bold tracking-tight truncate">
                <span className="md:hidden">{activeTabMeta.label}</span>
                <span className="hidden md:inline">UDC COMPHANY</span>
              </h1>
              <p className="text-[11px] md:text-xs text-muted-foreground truncate">
                {data.isGuest ? "modo livre" : `logado: ${user?.email ?? "—"}`}
                {filters.siteId !== "all" && (
                  <> • site={selectedSite?.name ?? filters.siteId.slice(0, 8)}</>
                )}
              </p>
            </div>
          </div>
          {/* Desktop actions */}
          <div className="hidden md:flex items-center gap-2 flex-wrap">
            <GlobalSiteSelector
              sites={data.sites}
              links={data.links}
              onChange={(siteId) => {
                const linked = siteId === "all"
                  ? []
                  : data.links.filter((l) => l.site_id === siteId).map((l) => l.google_account_id);
                handleFilterChange({ ...filters, siteId, googleAccountIds: linked });
              }}
            />
            <Button variant="outline" size="sm" onClick={insertSampleData} className="gap-2">
              <Plus className="h-4 w-4" /> Dados de teste
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void allSites.syncAll(true, range); }}
              disabled={!allSites.totalCount || allSites.processingCount > 0}
              className="gap-2"
              title="Sincroniza todos os sites"
            >
              <RefreshCw className={allSites.processingCount > 0 ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Sincronizar todos os sites
              {allSites.processingCount > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {allSites.processingCount}/{allSites.totalCount}
                </Badge>
              )}
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={syncing} className="gap-2">
              <RefreshCw className={syncing || evaluating ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              {syncing ? "Sincronizando…" : "Atualizar"}
            </Button>
            {currentRole && (
              <Badge
                variant="outline"
                className={
                  currentRole.isSuperAdmin ? "border-purple-500 text-purple-600 bg-purple-500/10"
                  : currentRole.role === "admin" ? "border-blue-500 text-blue-600 bg-blue-500/10"
                  : currentRole.role === "manager" ? "border-amber-500 text-amber-600 bg-amber-500/10"
                  : "border-slate-400 text-slate-600 bg-slate-400/10"
                }
              >
                {currentRole.isSuperAdmin ? "Super Admin"
                  : currentRole.role === "admin" ? "Admin"
                  : currentRole.role === "manager" ? "Manager" : "Viewer"}
              </Badge>
            )}
            {currentRole?.isSuperAdmin && (
              <Button variant="outline" size="sm" asChild className="gap-2" title="Gerenciar usuários">
                <Link to="/admin/users"><UserCog className="h-4 w-4" /> Admins</Link>
              </Button>
            )}
          </div>
          {/* Mobile: global site selector below title */}
          <div className="md:hidden">
            <GlobalSiteSelector
              sites={data.sites}
              links={data.links}
              onChange={(siteId) => {
                const linked = siteId === "all"
                  ? []
                  : data.links.filter((l) => l.site_id === siteId).map((l) => l.google_account_id);
                handleFilterChange({ ...filters, siteId, googleAccountIds: linked });
              }}
            />
          </div>
        </div>
      </header>


      <main className="w-full max-w-[3440px] mx-auto px-3 sm:px-4 lg:px-6 py-4 md:py-5 space-y-6 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="hidden md:block -mx-3 sm:mx-0 overflow-x-auto px-3 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsList className="w-max md:w-auto flex-nowrap">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <TabsTrigger key={t.value} value={t.value} className="gap-1.5">
                  <Icon className="h-3.5 w-3.5" /> {t.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
          </div>

          <TabsContent value="dashboard" className="space-y-6 mt-6">
            <DashboardErrorBoundary tabName="Dashboard">
            <FilterBar
              filters={filters}
              onChange={handleFilterChange}
              googleAccounts={data.googleAccounts}
              sites={data.sites}
              campaigns={data.campaigns}
              links={data.links}
            />

            {(() => {
              const fmtFresh = (iso: string | null) => {
                if (!iso) return "—";
                const d = new Date(iso);
                const sameDay = d.toDateString() === new Date().toDateString();
                return sameDay
                  ? `hoje ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
                  : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
              };
              const adsAt = adsFreshnessQuery.data ?? null;
              const gamInfo = gamFreshnessQuery.data;
              return (
                <div className="rounded-lg border border-border bg-card/40 px-3 py-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-primary" />
                    <span className="text-muted-foreground">Google Ads atualizado:</span>
                    <span className="font-mono font-medium">{fmtFresh(adsAt)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-success" />
                    <span className="font-mono font-medium">
                      {gamFreshnessQuery.isLoading ? "Verificando GAM…" : (gamInfo?.label ?? "Ad Manager: —")}
                    </span>
                    {gamInfo?.date && <span className="text-muted-foreground">({gamInfo.date})</span>}
                  </div>
                  <div className="flex items-center gap-1.5 ml-auto">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    <span className="text-muted-foreground">USD → BRL:</span>
                    <span className="font-mono font-medium">
                      R$ {usdBrl.toFixed(4)}
                    </span>
                    {fxSource && (
                      <span className="text-muted-foreground">({fxSource})</span>
                    )}
                    {fxUpdatedAt && (
                      <span className="text-muted-foreground">· {fmtFresh(fxUpdatedAt)}</span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={async () => {
                        try { await supabase.functions.invoke("fx-sync"); } catch {}
                        fxQuery.refetch();
                      }}
                    >
                      Atualizar
                    </Button>
                  </div>
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Receita GAM líquida (bruto −{(REV_SHARE_PCT * 100).toFixed(1)}%)</Badge>
              <Badge variant="outline">{isBrlSite ? "BRL nativo (GAM)" : "USD nativo (GAM)"}</Badge>
              {presetFromRange(filters.fromDate, filters.toDate) === "today" && (
                <Badge variant="secondary">
                  Hoje: GAM pode atrasar
                  {siteRealRevenueQuery.data?.effectiveDate ? ` — exibindo ${siteRealRevenueQuery.data.effectiveDate}` : " — exibindo último dado disponível"}
                </Badge>
              )}
              {totals.revenue === 0 && (
                <Badge variant="secondary">Sem receita do GAM no período</Badge>
              )}
              <Button variant="ghost" size="sm" onClick={() => setShowDebug((v) => !v)} className="ml-auto h-7">
                {showDebug ? "Ocultar debug" : "Mostrar debug"}
              </Button>
            </div>

            {showDebug && (
              <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-xs font-mono space-y-1">
                <div>gross_revenue_usd: <b>{grossRevenueUsd.toFixed(6)}</b></div>
                <div>real_gam_gross : <b>{realGamRevenueGrossDisplay.toFixed(6)}</b></div>
                <div>real_gam_net   : <b>{realGamRevenueNetDisplay.toFixed(6)}</b> (bruto −{(REV_SHARE_PCT * 100).toFixed(1)}%)</div>
                <div>net_revenue_usd  : <b>{totals.revenue.toFixed(6)}</b></div>
                <div>gross_profit_brl : <b>{grossProfitBrl.toFixed(2)}</b></div>
                <div>net_profit_brl   : <b>{totals.profit.toFixed(2)}</b></div>
                <div>spend_brl        : <b>{totals.spend.toFixed(2)}</b></div>
                <div>roi              : <b>{totals.roi.toFixed(2)}%</b> · roas <b>{totals.roas.toFixed(2)}x</b></div>
                <div>fx_usd_brl       : <b>{usdBrl.toFixed(4)}</b> · site_currency: <b>{selectedSite?.gam_currency ?? "—"}</b> · override: <b>{String((selectedSite as any)?.gam_currency_override ?? false)}</b></div>
                <div>campaigns: {engine?.aggregates.length ?? 0} · metrics rows: {filtered.metrics.length} · placements: {filtered.placements.length}</div>
              </div>
            )}

            {filters.siteId !== "all" && (
              <SiteSyncBanner siteId={filters.siteId} siteName={selectedSite?.name} />
            )}

            {/* Métricas */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <MetricCard
                label="Gasto (Google Ads)"
                value={fmtCurrency(totals.spend)}
                icon={Wallet}
                hint={`${engine?.aggregates.length ?? 0} campanha(s) · BRL`}
              />
              <MetricCard
                label="Receita (Ad Manager)"
                value={fmtRevenue(realGamRevenueNetDisplay > 0 ? realGamRevenueNetDisplay : attributedRevenueNetDisplay)}
                icon={DollarSign}
                variant="primary"
                hint={
                  realGamRevenueNetDisplay === 0 && attributedRevenueNetDisplay === 0
                    ? `${isBrlSite ? "BRL" : "USD"} nativo · Sem dados ainda do GAM (pode levar algumas horas)`
                    : realGamRevenueNetDisplay > 0
                      ? `GAM líquido${siteRealRevenueQuery.data?.effectiveDate ? ` (${siteRealRevenueQuery.data.effectiveDate})` : ""} · bruto ${fmtRevenue(realGamRevenueGrossDisplay)} −${(REV_SHARE_PCT * 100).toFixed(1)}% · atribuído: ${fmtRevenue(attributedRevenueNetDisplay)} (${attributionPct.toFixed(0)}%) · push ${fmtRevenue(extraPushDisplay)} · outras ${fmtRevenue(extraOtherDisplay)}`
                      : `Google + Push + Outras · push ${fmtRevenue(extraPushDisplay)} · outras ${fmtRevenue(extraOtherDisplay)}`
                }
              />
              <MetricCard
                label="Lucro"
                value={fmtCurrency(totals.profit)}
                icon={profitPositive ? TrendingUp : TrendingDown}
                variant={profitPositive ? "success" : "danger"}
                hint="BRL (receita convertida)"
              />
              <MetricCard
                label="ROI / ROAS"
                value={fmtPercent(totals.roi)}
                icon={profitPositive ? TrendingUp : TrendingDown}
                variant={profitPositive ? "success" : "danger"}
                hint={`ROAS ${totals.roas.toFixed(2)}x`}
              />
            </section>

            {siteMetricsQuery.data && (
              <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                <MetricCard
                  label="Viewability (GAM)"
                  value={`${siteMetricsQuery.data.viewability.toFixed(1)}%`}
                  icon={BarChart3}
                  hint="Active View · viewable / measurable"
                />
                <MetricCard
                  label="eCPM (GAM)"
                  value={
                    siteMetricsQuery.data.currency === "BRL"
                      ? fmtCurrency(siteMetricsQuery.data.ecpmNative)
                      : siteMetricsQuery.data.currency === "GAM"
                        ? fmtUSD(siteMetricsQuery.data.ecpmNative)
                      : fmtUSD(siteMetricsQuery.data.ecpmNative)
                  }
                  icon={DollarSign}
                  hint={`${siteMetricsQuery.data.currency === "GAM" ? "USD equivalente" : `${siteMetricsQuery.data.currency} nativo`} · ${siteMetricsQuery.data.impressions.toLocaleString("pt-BR")} impressões`}
                />
                <MetricCard
                  label="Moeda base"
                  value={filters.siteId === "all" ? "Misto" : "BRL"}
                  icon={Globe}
                  hint={filters.siteId === "all" ? `Todos os sites · taxa USD→BRL ${usdBrl.toFixed(4)}` : `Original: ${selectedSite?.gam_currency ?? "USD"} · taxa USD→BRL ${usdBrl.toFixed(4)}`}
                />
                <MetricCard
                  label="Site"
                  value={selectedSite?.name ?? "Todos"}
                  icon={MapPin}
                  hint={selectedSite?.domain ?? `${data.sites.length} sites`}
                />
              </section>
            )}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2">
                <RoiChart metrics={filtered.metrics} />
              </div>
              <AlertsPanel alerts={data.alerts} onAcknowledge={handleAcknowledge} />
            </section>

            {/* Linha 3: rankings */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <CampaignsRanking campaigns={engine?.aggregates ?? []} variant="best" />
              <CampaignsRanking campaigns={engine?.aggregates ?? []} variant="worst" />
              <PlacementsRanking placements={engine?.placementAggregates ?? []} />
            </section>

            {/* Visão por segmento */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Análise por segmento
              </h2>
              <SegmentTabs
                aggregates={engine?.aggregates ?? []}
                placements={engine?.placementAggregates ?? []}
                metrics={filtered.metrics}
                rawPlacements={filtered.placements}
                googleAccounts={data.googleAccounts}
                sites={data.sites}
                links={data.links}
              />
            </section>

            {/* Tabela de campanhas */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Campanhas
                </h2>
                <span className="text-xs text-muted-foreground">
                  {engine?.aggregates.length ?? 0} resultado(s)
                </span>
              </div>
              <CampaignsTable
                campaigns={engine?.aggregates ?? []}
                campaignGamMetrics={campaignGamMetricsQuery.data}
                campaignMatchRates={campaignMatchRateQuery.data}
                campaignBestMatches={campaignBestMatchQuery.data}
                downAccountIds={new Set(
                  (data.googleAccounts ?? [])
                    .filter((a) => a.status === "suspended" || a.status === "canceled")
                    .map((a) => a.id)
                )}
                onPause={(id) => queueAction(id, "pause", "Ação manual")}
                onBoost={(id) => queueAction(id, "increase_budget", "Ação manual")}
                onRefresh={data.refresh}
                dateRange={{ from: range.from, to: range.to }}
                siteId={filters.siteId}
              />
            </section>
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="calendar" className="mt-6">
            <DashboardErrorBoundary tabName="Calendário">
              <FinancialCalendarTab />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="integrations" className="mt-6">
            <DashboardErrorBoundary tabName="Integrações">
              <IntegrationsPanel
                googleAccounts={data.googleAccounts}
                gamAccounts={data.gamAccounts}
                sites={data.sites}
                links={data.links}
                isGuest={data.isGuest}
                onAddGoogleAccount={data.addGoogleAccount}
                onRemoveGoogleAccount={data.removeGoogleAccount}
                onAddGamAccount={data.addGamAccount}
                onRemoveGamAccount={data.removeGamAccount}
                onAddSite={data.addSite}
                onRemoveSite={data.removeSite}
                onAddLink={data.addLink}
                onRemoveLink={data.removeLink}
                onRefresh={data.refresh}
              />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="placements" className="mt-6">
            <DashboardErrorBoundary tabName="Placements">
              <PlacementsTab
                campaigns={data.campaigns}
                googleAccounts={data.googleAccounts}
                fxUsdBrl={usdBrl}
              />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="funnel" className="mt-6 space-y-6">
            <DashboardErrorBoundary tabName="Funil">
              <SmartFunnelPanel />
              <PlacementFunnelTab fxUsdBrl={usdBrl} />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="countries" className="mt-6">
            <DashboardErrorBoundary tabName="Países">
              <CountriesTab fxUsdBrl={usdBrl} />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="creatives" className="mt-6">
            <DashboardErrorBoundary tabName="Criativos">
              <CreativesTab fxUsdBrl={usdBrl} />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="retention" className="mt-6">
            <DashboardErrorBoundary tabName="Retenção / Push">
              <RetentionTab campaigns={data.campaigns} />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="automation" className="mt-6">
            <DashboardErrorBoundary tabName="Automação">
              <AutomationTab />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="scale-unlock" className="mt-6">
            <DashboardErrorBoundary tabName="Destravar Escala">
              <ScaleUnlockTab />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="migration" className="mt-6">
            <DashboardErrorBoundary tabName="Migração">
              <MigrationTab />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="rules" className="mt-6">
            <DashboardErrorBoundary tabName="Regras">
              <RulesPanel rules={data.rules} onSave={data.saveRules} />
            </DashboardErrorBoundary>
          </TabsContent>

          <TabsContent value="history" className="mt-6">
            <DashboardErrorBoundary tabName="Histórico">
              <HistoryTab />
            </DashboardErrorBoundary>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
