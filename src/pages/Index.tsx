import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3, DollarSign, Plus, RefreshCw, TrendingDown,
  TrendingUp, Wallet, Settings, Plug, LayoutDashboard, MapPin, Repeat,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useDashboardData } from "@/hooks/useDashboardData";
import { evaluate } from "@/engine/rules";
import { fmtCurrency, fmtUSD, fmtPercent } from "@/lib/format";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { CampaignsRanking, PlacementsRanking } from "@/components/dashboard/Rankings";
import { RoiChart } from "@/components/dashboard/RoiChart";
import { CampaignsTable } from "@/components/dashboard/CampaignsTable";
import { RulesPanel } from "@/components/dashboard/RulesPanel";
import { IntegrationsPanel } from "@/components/dashboard/IntegrationsPanel";
import { FilterBar, presetFromRange, type DashboardFilters } from "@/components/dashboard/FilterBar";
import { FilterProvider, useDashboardFilters } from "@/contexts/FilterContext";
import { useQuery } from "@tanstack/react-query";
import { SegmentTabs } from "@/components/dashboard/SegmentTabs";
import { PlacementsTab } from "@/components/dashboard/PlacementsTab";
import { RetentionTab } from "@/components/dashboard/RetentionTab";
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

  // Última atualização real dos dados (timestamps de update no banco)
  const freshnessQuery = useQuery({
    queryKey: ["data-freshness", filters.siteId, filters.googleAccountIds.join("|")],
    queryFn: async () => {
      let adsQ = supabase
        .from("daily_metrics")
        .select("updated_at")
        .order("updated_at", { ascending: false })
        .limit(1);
      if (filters.googleAccountIds.length > 0) adsQ = adsQ.in("google_account_id", filters.googleAccountIds);

      let gamQ = supabase
        .from("gam_campaign_source_revenue")
        .select("created_at")
        .order("created_at", { ascending: false })
        .limit(1);
      if (filters.siteId !== "all") gamQ = gamQ.eq("site_id", filters.siteId);

      const [ads, gam] = await Promise.all([adsQ, gamQ]);
      return {
        ads: ads.data?.[0]?.updated_at ?? null,
        gam: gam.data?.[0]?.created_at ?? null,
      };
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
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
    const metrics: DailyMetric[] = data.metrics.filter(
      (m) => matchCampaign(m.campaign_id, m.google_account_id) && inDateRange(m.date),
    );
    const placements: Placement[] = data.placements.filter((p) => {
      const cidOk = filters.campaignId === "all" || p.campaign_id === filters.campaignId;
      const siteOk = filters.siteId === "all" || p.site_id === filters.siteId
        || data.sites.find((s) => s.id === filters.siteId)?.name === p.site;
      return cidOk && siteOk && inDateRange(p.date);
    });

    return { campaigns, metrics, placements };
  }, [data.campaigns, data.metrics, data.placements, data.links, data.sites, filters]);

  const engine = useMemo(() => {
    if (!data.rules) return null;
    return evaluate({
      campaigns: filtered.campaigns,
      metrics: filtered.metrics,
      placements: filtered.placements,
      rules: data.rules,
    });
  }, [filtered, data.rules]);

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

  const handleRefresh = async () => {
    await syncDashboardData(filters);
  };

  const syncDashboardData = useCallback(async (nextFilters: DashboardFilters) => {
    const preset = presetFromRange(nextFilters.fromDate, nextFilters.toDate);
    const defaultRange = (() => {
      const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const d = new Date();
      d.setDate(d.getDate() - 6);
      return { from: toIso(d), to: toIso(new Date()) };
    })();
    const from = nextFilters.fromDate || defaultRange.from;
    const to = nextFilters.toDate || defaultRange.to;
    const body = {
      from,
      to,
      site_id: nextFilters.siteId === "all" ? undefined : nextFilters.siteId,
      account_ids: nextFilters.googleAccountIds,
      // Para "Hoje", incluímos ontem como fallback (GAM atrasa horas).
      include_yesterday_fallback: preset === "today",
    };

    toast({ title: "Sincronizando", description: "Filtros atualizados" });
    if (import.meta.env.DEV) {
      console.info("[dashboard-sync] request", { filter: nextFilters, appliedDate: { from, to }, queryKeys: { dashboard: ["dashboard", user?.id ?? "guest", from, to], retention: ["retention", from, to] } });
    }
    const adsRes = await supabase.functions.invoke<{ ok?: boolean; error?: string; debug?: unknown }>(
      "google-ads-sync-campaigns",
      { body },
    );
    const gamRes = await supabase.functions.invoke<{ ok?: boolean; error?: string; debug?: unknown; gam_debug?: unknown }>(
      "gam-sync-revenue",
      { body },
    );

    if (import.meta.env.DEV) {
      console.info("[dashboard-sync] Google Ads", adsRes.data ?? adsRes.error);
      console.info("[dashboard-sync] GAM", gamRes.data ?? gamRes.error);
    }

    const adsErr = adsRes.error?.message ?? adsRes.data?.error;
    const gamErr = gamRes.error?.message ?? gamRes.data?.error;
    if (adsErr) toast({ title: "Erro Google Ads", description: adsErr, variant: "destructive" });
    if (gamErr) toast({ title: "Erro GAM", description: gamErr, variant: "destructive" });
    if (!adsErr && !gamErr) {
      toast({ title: "Dados atualizados" });
    }
    await data.refresh();
  }, [data]);

  const handleFilterChange = (nextFilters: DashboardFilters) => {
    const shouldSync =
      nextFilters.siteId !== filters.siteId ||
      nextFilters.fromDate !== filters.fromDate ||
      nextFilters.toDate !== filters.toDate ||
      nextFilters.googleAccountIds.join("|") !== filters.googleAccountIds.join("|");
    setFilters(nextFilters);
    if (import.meta.env.DEV) {
      console.info("[dashboard] filters change", { from: nextFilters.fromDate, to: nextFilters.toDate, accounts: nextFilters.googleAccountIds, site: nextFilters.siteId, shouldSync });
    }
    if (shouldSync) void syncDashboardData(nextFilters);
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
  const totalRevenueUsd = baseTotals.revenue + extraNetUsd;
  const totalProfitBrl = baseTotals.profit + extraNetBrl;
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
  // Debug: receita bruta a partir das métricas filtradas (antes do rev share)
  const grossRevenueUsd = filtered.metrics.reduce((acc, m) => acc + Number(m.revenue ?? 0), 0);
  const grossProfitBrl = filtered.metrics.reduce((acc, m) => acc + Number(m.profit ?? 0), 0);

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
                {data.isGuest ? "modo livre" : `logado: ${user?.email ?? "—"}`} •{" "}
                {data.lastSyncedAt ? `sync ${data.lastSyncedAt.toLocaleTimeString("pt-BR")}` : "—"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={insertSampleData} className="gap-2">
              <Plus className="h-4 w-4" /> Dados de teste
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={data.loading} className="gap-2">
              <RefreshCw className={data.loading || evaluating ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Atualizar
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
            <TabsTrigger value="integrations" className="gap-1.5">
              <Plug className="h-3.5 w-3.5" /> Integrações
            </TabsTrigger>
            <TabsTrigger value="placements" className="gap-1.5">
              <MapPin className="h-3.5 w-3.5" /> Placements
            </TabsTrigger>
            <TabsTrigger value="retention" className="gap-1.5">
              <Repeat className="h-3.5 w-3.5" /> Retenção / Push
            </TabsTrigger>
            <TabsTrigger value="rules" className="gap-1.5">
              <Settings className="h-3.5 w-3.5" /> Regras
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="space-y-6 mt-6">
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
              const adsAt = freshnessQuery.data?.ads ?? null;
              const gamAt = freshnessQuery.data?.gam ?? null;
              return (
                <div className="rounded-lg border border-border bg-card/40 px-3 py-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-primary" />
                    <span className="text-muted-foreground">Google Ads atualizado:</span>
                    <span className="font-mono font-medium">{fmtFresh(adsAt)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-success" />
                    <span className="text-muted-foreground">Ad Manager atualizado:</span>
                    <span className="font-mono font-medium">{fmtFresh(gamAt)}</span>
                  </div>
                </div>
              );
            })()}

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Receita líquida (rev share {(REV_SHARE_PCT * 100).toFixed(1)}%)</Badge>
              <Badge variant="outline">USD nativo (GAM)</Badge>
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
                <div>campaigns: {engine?.aggregates.length ?? 0} · metrics rows: {filtered.metrics.length} · placements: {filtered.placements.length}</div>
              </div>
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
                value={fmtUSD(totals.revenue)}
                icon={DollarSign}
                variant="primary"
                hint={
                  totals.revenue === 0
                    ? "USD nativo · Sem dados ainda do GAM (pode levar algumas horas)"
                    : `Google + Push + Outras · push ${fmtUSD(extraPushUsd * NET_FACTOR)} · outras ${fmtUSD(extraOtherUsd * NET_FACTOR)}`
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

            {/* Linha 2: gráfico + alertas */}
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
                onPause={(id) => queueAction(id, "pause", "Ação manual")}
                onBoost={(id) => queueAction(id, "increase_budget", "Ação manual")}
                onRefresh={data.refresh}
              />
            </section>
          </TabsContent>

          <TabsContent value="integrations" className="mt-6">
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
          </TabsContent>

          <TabsContent value="placements" className="mt-6">
            <PlacementsTab
              campaigns={data.campaigns}
              googleAccounts={data.googleAccounts}
            />
          </TabsContent>

          <TabsContent value="retention" className="mt-6">
            <RetentionTab campaigns={data.campaigns} />
          </TabsContent>

          <TabsContent value="rules" className="mt-6">
            <RulesPanel rules={data.rules} onSave={data.saveRules} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
