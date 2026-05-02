import { useEffect, useMemo, useState } from "react";
import {
  BarChart3, DollarSign, Plus, RefreshCw, TrendingDown,
  TrendingUp, Wallet, Settings, Plug, LayoutDashboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { FilterBar, EMPTY_FILTERS, type DashboardFilters } from "@/components/dashboard/FilterBar";
import { SegmentTabs } from "@/components/dashboard/SegmentTabs";
import type { Campaign, DailyMetric, Placement } from "@/types/domain";
import { supabase } from "@/integrations/supabase/client";

const Index = () => {
  const { user } = useAuth();
  const data = useDashboardData();
  const [evaluating, setEvaluating] = useState(false);
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_FILTERS);

  // Aplica filtros aos dados crus antes de mandar para a engine
  const filtered = useMemo(() => {
    const accountCampaignIds = new Set(
      filters.googleAccountId === "all"
        ? data.campaigns.map((c) => c.campaign_id)
        : data.campaigns
            .filter((c) => c.google_account_id === filters.googleAccountId)
            .map((c) => c.campaign_id),
    );

    const siteCampaignIds = new Set(
      filters.siteId === "all"
        ? data.campaigns.map((c) => c.campaign_id)
        : (() => {
            const linkedAccIds = data.links
              .filter((l) => l.site_id === filters.siteId)
              .map((l) => l.google_account_id);
            return data.campaigns
              .filter((c) => linkedAccIds.includes(c.google_account_id ?? ""))
              .map((c) => c.campaign_id);
          })(),
    );

    const matchCampaign = (cid: string) =>
      (filters.campaignId === "all" || filters.campaignId === cid) &&
      accountCampaignIds.has(cid) && siteCampaignIds.has(cid);

    const inDateRange = (date: string) =>
      (!filters.fromDate || date >= filters.fromDate) &&
      (!filters.toDate || date <= filters.toDate);

    const campaigns: Campaign[] = data.campaigns.filter((c) => matchCampaign(c.campaign_id));
    const metrics: DailyMetric[] = data.metrics.filter(
      (m) => matchCampaign(m.campaign_id) && inDateRange(m.date),
    );
    const placements: Placement[] = data.placements.filter((p) => {
      const cidOk = !p.campaign_id || matchCampaign(p.campaign_id);
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
    await data.refresh();
    toast({ title: "Dados atualizados" });
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

  const totals = engine?.totals ?? { spend: 0, revenue: 0, profit: 0, roi: 0, roas: 0 };
  const profitPositive = totals.profit >= 0;

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
            <TabsTrigger value="rules" className="gap-1.5">
              <Settings className="h-3.5 w-3.5" /> Regras
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="space-y-6 mt-6">
            <FilterBar
              filters={filters}
              onChange={setFilters}
              googleAccounts={data.googleAccounts}
              sites={data.sites}
              campaigns={data.campaigns}
              onPresetApply={async (_key, gaql) => {
                toast({ title: "Sincronizando", description: `Período: ${gaql.replace(/_/g, " ")}` });
                const { data: resp, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
                  "google-ads-sync-campaigns",
                  { body: { date_preset: gaql } },
                );
                if (error || resp?.error) {
                  toast({ title: "Erro ao sincronizar", description: resp?.error ?? error?.message ?? "Falha", variant: "destructive" });
                  return;
                }
                toast({ title: "Dados atualizados" });
                await data.refresh();
              }}
            />

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
                hint="USD nativo"
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

          <TabsContent value="rules" className="mt-6">
            <RulesPanel rules={data.rules} onSave={data.saveRules} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
