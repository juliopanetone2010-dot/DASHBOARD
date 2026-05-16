import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3, DollarSign, Plus, RefreshCw, TrendingDown,
  TrendingUp, Wallet, Settings, Plug, LayoutDashboard, MapPin, Repeat, Globe, Bot, Sparkles, CalendarDays, Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useQuery } from "@tanstack/react-query";
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
import { SiteSyncBanner } from "@/components/dashboard/SiteSyncBanner";

import { useAllSitesOnboarding } from "@/hooks/useAllSitesOnboarding";
import type { Campaign, DailyMetric, Placement } from "@/types/domain";
import { REV_SHARE_PCT, NET_FACTOR } from "@/engine/rules";
import { supabase } from "@/integrations/supabase/client";

const Index = () => {
  return (
    <FilterProvider>
      <IndexInner />
    </FilterProvider>
  );
};

const IndexInner = () => {
  const { user } = useAuth();
  const data = useDashboardData();
  const [evaluating, setEvaluating] = useState(false);
  const { filters, setFilters, range } = useDashboardFilters();
  const [showDebug, setShowDebug] = useState(false);
  const allSites = useAllSitesOnboarding(!!user);
  const [syncingCampaigns, setSyncingCampaigns] = useState(false);

  const syncCampaignsNow = async () => {
    setSyncingCampaigns(true);
    try {
      const { data: r, error } = await supabase.functions.invoke("google-ads-sync-campaigns", {
        body: { date_preset: "LAST_7_DAYS" },
      });
      if (error) throw error;
      const total = (r as any)?.campaigns_upserted ?? (r as any)?.upserted ?? (r as any)?.rows ?? 0;
      toast({ title: "Campanhas sincronizadas", description: `${total} campanha(s) atualizada(s).` });
      await data.refresh();
    } catch (e: any) {
      toast({ title: "Falha ao sincronizar campanhas", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setSyncingCampaigns(false);
    }
  };

  // Receita extra (push + outras origens) vinda do GAM por UTM, para somar ao ROI/ROAS
  const extraRevQuery = useQuery({
    queryKey: ["extra-revenue", range.from, range.to, filters.siteId, filters.googleAccountIds.join("|")],
    queryFn: async () => {
      let q = supabase
        .from("gam_campaign_source_revenue")
        .select("utm_source, revenue_usd, date")
        .gte("date", range.from)
        .lte("date", range.to);
      if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
      const { data: rows } = await q.limit(5000);
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

  const fxQuery = useQuery<number>({
    queryKey: ["fx-usd-brl"],
    queryFn: async () => {
      const r = await fetch("https://open.er-api.com/v6/latest/USD");
      const j = await r.json();
      const rate = Number(j?.rates?.BRL);
      return Number.isFinite(rate) && rate > 0 ? rate : 5;
    },
    staleTime: 60 * 60 * 1000,
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
    enabled: filters.siteId !== "all",
    queryFn: async () => {
      // Use the user-selected window exactly. The previous version forced a
      // 7-day minimum lookback "as a fallback when GAM had no recent data",
      // but that meant Hoje / Ontem / 3-dias all showed the SAME numbers (the
      // last 7 days), making the period selector useless for viewability /
      // eCPM. Julio reported this on 2026-05-16. The right behavior is
      // honour-the-period; if there's no data the card just shows 0/—.
      const todayISO = new Date().toISOString().slice(0, 10);
      const toIncl = range.to >= todayISO ? range.to : todayISO;
      const fromIncl = range.from;
      const { data, error } = await supabase
        .from("site_metrics_daily")
        .select("date, impressions, measurable_impressions, viewable_impressions, revenue_native, currency, ecpm_native")
        .eq("site_id", filters.siteId)
        .gte("date", fromIncl).lte("date", toIncl)
        .order("date", { ascending: false })
        .limit(400);
      if (error) {
        console.error("[site-metrics-daily] query error", error);
        throw error;
      }
      if (import.meta.env.DEV) {
        console.info("[site-metrics-daily] rows", { siteId: filters.siteId, from: fromIncl, to: toIncl, count: data?.length ?? 0, sample: data?.[0] });
      }
      const totals = (data ?? []).reduce((a, r: any) => ({
        impr: a.impr + Number(r.impressions ?? 0),
        meas: a.meas + Number(r.measurable_impressions ?? 0),
        view: a.view + Number(r.viewable_impressions ?? 0),
        rev: a.rev + Number(r.revenue_native ?? 0),
        currency: r.currency || a.currency,
      }), { impr: 0, meas: 0, view: 0, rev: 0, currency: "USD" });
      const viewability = totals.meas > 0 ? (totals.view / totals.meas) * 100 : 0;
      const ecpmNative = totals.impr > 0 ? (totals.rev / totals.impr) * 1000 : 0;
      return { viewability, ecpmNative, currency: totals.currency, impressions: totals.impr };
    },
    staleTime: 30_000,
    refetchInterval: 2 * 60_000,
  });

  // Receita REAL do GAM no range exato (sem ampliar lookback). Usado pra mostrar o total verdadeiro
  // do Ad Manager no card "Receita", mesmo quando parte das impressões não foi atribuída via UTM.
  const siteRealRevenueQuery = useQuery({
    queryKey: ["site-real-revenue", filters.siteId, range.from, range.to],
    queryFn: async () => {
      let q = supabase.from("site_metrics_daily")
        .select("revenue_native, currency, impressions, site_id")
        .gte("date", range.from).lte("date", range.to)
        .limit(5000);
      if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
      const { data, error } = await q;
      if (error) throw error;
      const totals = (data ?? []).reduce((a, r: any) => {
        const cur = String(r.currency || "USD").toUpperCase();
        a.byCurrency[cur] = (a.byCurrency[cur] ?? 0) + Number(r.revenue_native ?? 0);
        a.impressions += Number(r.impressions ?? 0);
        return a;
      }, { byCurrency: {} as Record<string, number>, impressions: 0 });
      return totals;
    },
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });
  // Atribuição por site quando uma conta Ads serve N sites:
  // shareByCampaignSite[campaign][site] = % da receita GAM confirmada por placement daquele campaign que veio do site.
  // Usado para multiplicar spend / clicks / conv quando filtros.siteId !== "all".
  const siteShareQuery = useQuery({
    queryKey: ["site-share", range.from, range.to],
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("gam_placement_revenue")
        .select("campaign_id, site_id, revenue_usd")
        .not("site_id", "is", null)
        .neq("campaign_id", "__aggregate__")
        .gte("date", range.from).lte("date", range.to)
        .limit(50000);
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
        await allSites.syncAll(true);
      } else {
        await supabase.functions.invoke("site-auto-onboard", { body: { site_id: nextFilters.siteId, force: true } });
        toast({ title: "Sincronização em fila", description: "O site está atualizando em segundo plano; a tela continua usando os dados já salvos." });
      }
      lastSyncRef.current = { key: cacheKey, at: Date.now() };
      await data.refresh();
    } catch (e: any) {
      toast({ title: "Erro na sincronização", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }, [allSites, data]);

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
  const usdBrl = fxQuery.data ?? 5;
  const extraPushUsd = extraRevQuery.data?.push ?? 0;
  const extraOtherUsd = extraRevQuery.data?.other ?? 0;
  const extraNetUsd = (extraPushUsd + extraOtherUsd) * NET_FACTOR;
  const extraNetBrl = extraNetUsd * usdBrl;

  // Receita REAL do GAM em BRL (independe do display). Inclui impressões SEM UTM.
  // Quando disponível, vira a base do ROI/lucro — assim o ROI reflete a verdade do Ad Manager.
  const realGamRevenueBrl = (() => {
    const byCur = siteRealRevenueQuery.data?.byCurrency ?? {};
    let total = 0;
    for (const [cur, val] of Object.entries(byCur)) {
      if (cur === "BRL") total += val;
      else total += val * usdBrl; // USD ou fallback
    }
    return total;
  })();
  const hasRealGam = realGamRevenueBrl > 0;
  // Se temos receita real do GAM, usamos ela (líquida) como base do ROI.
  // Caso contrário, fallback para receita atribuída via UTM (Google) + push/outras.
  const totalProfitBrl = hasRealGam
    ? realGamRevenueBrl * NET_FACTOR - baseTotals.spend
    : baseTotals.profit + extraNetBrl;
  const totalRevenueUsd = hasRealGam
    ? (realGamRevenueBrl * NET_FACTOR) / usdBrl
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
  const selectedSite = filters.siteId !== "all"
    ? data.sites.find((s) => s.id === filters.siteId)
    : null;
  const isBrlSite = String(selectedSite?.gam_currency ?? "USD").toUpperCase() === "BRL";
  const revenueDisplay = isBrlSite ? totals.revenue * usdBrl : totals.revenue;
  const extraPushDisplay = isBrlSite ? extraPushUsd * NET_FACTOR * usdBrl : extraPushUsd * NET_FACTOR;
  const extraOtherDisplay = isBrlSite ? extraOtherUsd * NET_FACTOR * usdBrl : extraOtherUsd * NET_FACTOR;
  const fmtRevenue = (v: number) => isBrlSite ? fmtCurrency(v) : fmtUSD(v);
  // Debug: receita bruta a partir das métricas filtradas (antes do rev share)
  const grossRevenueUsd = filtered.metrics.reduce((acc, m) => acc + Number(m.revenue ?? 0), 0);
  const grossProfitBrl = filtered.metrics.reduce((acc, m) => acc + Number(m.profit ?? 0), 0);

  // Receita REAL do GAM (somando todas moedas convertidas pra BRL/USD do site).
  // Inclui impressões SEM tag UTM — o card principal deve mostrar a verdade do Ad Manager,
  // mesmo que ROI/lucro continuem usando só a parte atribuída a campanhas.
  const realGamRevenueDisplay = (isBrlSite ? realGamRevenueBrl : realGamRevenueBrl / usdBrl) * NET_FACTOR;
  // Receita "atribuída" antiga = só Google UTM + push/outras (sem impressões sem tag)
  const attributedRevenueUsd = (engine?.totals.revenue ?? 0) + extraNetUsd;
  const attributedRevenueDisplay = isBrlSite ? attributedRevenueUsd * usdBrl : attributedRevenueUsd;
  const attributionPct = realGamRevenueDisplay > 0
    ? (attributedRevenueDisplay / realGamRevenueDisplay) * 100
    : 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="container flex flex-col md:flex-row md:items-center md:justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
              <BarChart3 className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Arbitrage Engine</h1>
              <p className="text-xs text-muted-foreground">
                {data.isGuest ? "modo livre" : `logado: ${user?.email ?? "—"}`}
                {filters.siteId !== "all" && (
                  <> • site={selectedSite?.name ?? filters.siteId.slice(0, 8)} • {filtered.campaigns.length} camp · {filtered.placements.length} place</>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
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
              onClick={() => { void allSites.syncAll(true); }}
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
            <Button variant="outline" size="sm" onClick={syncCampaignsNow} disabled={syncingCampaigns} className="gap-2" title="Busca campanhas novas no Google Ads e atualiza a lista">
              <RefreshCw className={syncingCampaigns ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              {syncingCampaigns ? "Sincronizando campanhas…" : "Sincronizar campanhas"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={syncing} className="gap-2">
              <RefreshCw className={syncing || evaluating ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              {syncing ? "Sincronizando…" : "Atualizar"}
            </Button>
          </div>

        </div>
      </header>

      <main className="container py-6 space-y-6">
        <Tabs defaultValue="dashboard">
          <TabsList>
            <TabsTrigger value="dashboard" className="gap-1.5">
              <LayoutDashboard className="h-3.5 w-3.5" /> Dashboard
            </TabsTrigger>
            <TabsTrigger value="calendar" className="gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" /> Calendário
            </TabsTrigger>
            <TabsTrigger value="integrations" className="gap-1.5">
              <Plug className="h-3.5 w-3.5" /> Integrações
            </TabsTrigger>
            <TabsTrigger value="placements" className="gap-1.5">
              <MapPin className="h-3.5 w-3.5" /> Placements
            </TabsTrigger>
            <TabsTrigger value="funnel" className="gap-1.5">
              <BarChart3 className="h-3.5 w-3.5" /> Funil
            </TabsTrigger>
            <TabsTrigger value="countries" className="gap-1.5">
              <Globe className="h-3.5 w-3.5" /> Países
            </TabsTrigger>
            <TabsTrigger value="creatives" className="gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> Criativos
            </TabsTrigger>
            <TabsTrigger value="retention" className="gap-1.5">
              <Repeat className="h-3.5 w-3.5" /> Retenção / Push
            </TabsTrigger>
            <TabsTrigger value="automation" className="gap-1.5">
              <Bot className="h-3.5 w-3.5" /> Automação
            </TabsTrigger>
            <TabsTrigger value="scale-unlock" className="gap-1.5">
              <Rocket className="h-3.5 w-3.5" /> Destravar Escala
            </TabsTrigger>
            <TabsTrigger value="migration" className="gap-1.5">
              <Repeat className="h-3.5 w-3.5" /> Migração
            </TabsTrigger>
            <TabsTrigger value="rules" className="gap-1.5">
              <Settings className="h-3.5 w-3.5" /> Regras
            </TabsTrigger>
          </TabsList>

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
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Receita líquida (rev share {(REV_SHARE_PCT * 100).toFixed(1)}%)</Badge>
              <Badge variant="outline">{isBrlSite ? "BRL nativo (GAM)" : "USD nativo (GAM)"}</Badge>
              {presetFromRange(filters.fromDate, filters.toDate) === "today" && (
                <Badge variant="secondary">Hoje: GAM pode atrasar — exibindo último dado disponível</Badge>
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
                <div>net_revenue_usd  : <b>{totals.revenue.toFixed(6)}</b> (× {(1 - REV_SHARE_PCT).toFixed(3)})</div>
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
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                label="Gasto (Google Ads)"
                value={fmtCurrency(totals.spend)}
                icon={Wallet}
                hint={`${engine?.aggregates.length ?? 0} campanha(s) · BRL`}
              />
              <MetricCard
                label="Receita (Ad Manager)"
                value={fmtRevenue(realGamRevenueDisplay > 0 ? realGamRevenueDisplay : attributedRevenueDisplay)}
                icon={DollarSign}
                variant="primary"
                hint={
                  realGamRevenueDisplay === 0 && attributedRevenueDisplay === 0
                    ? `${isBrlSite ? "BRL" : "USD"} nativo · Sem dados ainda do GAM (pode levar algumas horas)`
                    : realGamRevenueDisplay > 0
                      ? `Atribuído ao Google Ads: ${fmtRevenue(attributedRevenueDisplay)} (${attributionPct.toFixed(0)}%) · push ${fmtRevenue(extraPushDisplay)} · outras ${fmtRevenue(extraOtherDisplay)}`
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

            {filters.siteId !== "all" && siteMetricsQuery.data && (
              <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
                      : fmtUSD(siteMetricsQuery.data.ecpmNative)
                  }
                  icon={DollarSign}
                  hint={`${siteMetricsQuery.data.currency} nativo · ${siteMetricsQuery.data.impressions.toLocaleString("pt-BR")} impressões`}
                />
                <MetricCard
                  label="Moeda base"
                  value="BRL"
                  icon={Globe}
                  hint={`Original: ${selectedSite?.gam_currency ?? "USD"} · taxa USD→BRL ${usdBrl.toFixed(4)}`}
                />
                <MetricCard
                  label="Site"
                  value={selectedSite?.name ?? "—"}
                  icon={MapPin}
                  hint={selectedSite?.domain ?? ""}
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
                downAccountIds={new Set(
                  (data.googleAccounts ?? [])
                    .filter((a) => a.status === "suspended" || a.status === "canceled")
                    .map((a) => a.id)
                )}
                onPause={(id) => queueAction(id, "pause", "Ação manual")}
                onBoost={(id) => queueAction(id, "increase_budget", "Ação manual")}
                onRefresh={data.refresh}
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
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
