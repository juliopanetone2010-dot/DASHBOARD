import { useEffect, useMemo, useState } from "react";
import {
  BarChart3, DollarSign, LogOut, Plus, RefreshCw, TrendingDown,
  TrendingUp, Wallet, Settings, Plug, LayoutDashboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useDashboardData } from "@/hooks/useDashboardData";
import { evaluate } from "@/engine/rules";
import { fmtCurrency, fmtPercent } from "@/lib/format";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { AlertsPanel } from "@/components/dashboard/AlertsPanel";
import { CampaignsRanking, PlacementsRanking } from "@/components/dashboard/Rankings";
import { RoiChart } from "@/components/dashboard/RoiChart";
import { CampaignsTable } from "@/components/dashboard/CampaignsTable";
import { RulesPanel } from "@/components/dashboard/RulesPanel";
import { IntegrationsPanel } from "@/components/dashboard/IntegrationsPanel";

const Index = () => {
  const { user, signOut } = useAuth();
  const data = useDashboardData();
  const [evaluating, setEvaluating] = useState(false);

  const engine = useMemo(() => {
    if (!data.rules) return null;
    return evaluate({
      campaigns: data.campaigns,
      metrics: data.metrics,
      placements: data.placements,
      rules: data.rules,
    });
  }, [data.campaigns, data.metrics, data.placements, data.rules]);

  // Persiste alertas gerados pela engine (só os novos, sem duplicar por título)
  useEffect(() => {
    if (!engine || !user) return;
    const existingTitles = new Set(data.alerts.filter((a) => !a.acknowledged).map((a) => a.title));
    const newOnes = engine.alerts.filter((a) => !existingTitles.has(a.title));
    if (newOnes.length === 0) return;

    setEvaluating(true);
    supabase
      .from("alerts")
      .insert(newOnes.map((a) => ({
        user_id: user.id,
        severity: a.severity,
        category: a.category,
        campaign_id: a.campaign_id,
        placement_key: a.placement_key,
        title: a.title,
        message: a.message,
        metric_snapshot: a.metric_snapshot ?? null,
      })))
      .then(() => setEvaluating(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine?.alerts.length, user?.id]);

  const handleRefresh = async () => {
    await data.refresh();
    toast({ title: "Dados atualizados" });
  };

  const handleAcknowledge = async (id: string) => {
    await supabase.from("alerts").update({ acknowledged: true }).eq("id", id);
    data.refresh();
  };

  // Pause / Boost: registram a ação como pending e refazem fetch
  const queueAction = async (
    campaignId: string, action: "pause" | "increase_budget", reason: string,
  ) => {
    if (!user) return;
    await supabase.from("automation_actions").insert({
      user_id: user.id,
      campaign_id: campaignId,
      action_type: action,
      reason,
      status: "pending",
    });
    toast({
      title: action === "pause" ? "Pausa enfileirada" : "Aumento sugerido",
      description: "Ação registrada como pendente. Execução real entra na Fase 4.",
    });
  };

  // Insere dados de teste para o usuário ver a engine viva
  const insertSampleData = async () => {
    if (!user) return;
    const today = new Date();
    const dayOf = (offset: number) => {
      const d = new Date(today); d.setDate(d.getDate() - offset);
      return d.toISOString().slice(0, 10);
    };
    const samples = [
      { id: "C-1001", name: "Display - Notícias BR",   spend: 320, revenue: 540 },
      { id: "C-1002", name: "Display - Esportes",      spend: 480, revenue: 720 },
      { id: "C-1003", name: "Display - Lifestyle",     spend: 290, revenue: 95  }, // ROI ruim → alerta
      { id: "C-1004", name: "Display - Tech YT",       spend: 660, revenue: 1240 },
      { id: "C-1005", name: "Display - Finanças",      spend: 220, revenue: 712 }, // ROI alto → boost
    ];

    await supabase.from("campaigns").upsert(
      samples.map((s) => ({
        user_id: user.id, campaign_id: s.id, name: s.name,
        status: "enabled", channel_type: "DISPLAY",
      })),
      { onConflict: "user_id,campaign_id" },
    );

    const rows = [];
    for (const s of samples) {
      for (let d = 0; d < 3; d++) {
        const spend = s.spend / 3;
        const revenue = s.revenue / 3;
        rows.push({
          user_id: user.id, campaign_id: s.id, date: dayOf(d),
          spend, revenue,
          profit: revenue - spend,
          roi: spend > 0 ? ((revenue - spend) / spend) * 100 : 0,
          roas: spend > 0 ? revenue / spend : 0,
          clicks: Math.round(spend * 8),
          conversions: Math.round(revenue / 30),
          impressions: Math.round(spend * 320),
          ecpm: spend > 0 ? (revenue / (spend * 320)) * 1000 : 0,
        });
      }
    }
    await supabase.from("daily_metrics").upsert(rows, { onConflict: "user_id,campaign_id,date" });

    // Placements de teste
    await supabase.from("placements").upsert([
      { user_id: user.id, placement_key: "site-a/box-300x250", campaign_id: "C-1001", site: "Notícias BR", ad_unit: "box-300x250", date: dayOf(0), impressions: 25000, revenue: 180, ecpm: 7.2 },
      { user_id: user.id, placement_key: "site-b/sticky-728",  campaign_id: "C-1004", site: "Tech YT",     ad_unit: "sticky-728",  date: dayOf(0), impressions: 41000, revenue: 410, ecpm: 10.0 },
      { user_id: user.id, placement_key: "site-c/footer",      campaign_id: "C-1003", site: "Lifestyle",   ad_unit: "footer",      date: dayOf(0), impressions: 18000, revenue: 1.6, ecpm: 0.09 },
    ], { onConflict: "user_id,placement_key,date" });

    toast({ title: "Dados de teste inseridos", description: "A engine vai gerar alertas em seguida." });
    data.refresh();
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
                {user?.email} • {data.lastSyncedAt
                  ? `sync ${data.lastSyncedAt.toLocaleTimeString("pt-BR")}`
                  : "—"}
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
            <Button variant="ghost" size="icon" onClick={signOut} title="Sair">
              <LogOut className="h-4 w-4" />
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
            {/* Métricas */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                label="Gasto (Google Ads)"
                value={fmtCurrency(totals.spend)}
                icon={Wallet}
                hint={`${engine?.aggregates.length ?? 0} campanha(s)`}
              />
              <MetricCard
                label="Receita (Ad Manager)"
                value={fmtCurrency(totals.revenue)}
                icon={DollarSign}
                variant="primary"
              />
              <MetricCard
                label="Lucro"
                value={fmtCurrency(totals.profit)}
                icon={profitPositive ? TrendingUp : TrendingDown}
                variant={profitPositive ? "success" : "danger"}
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
                <RoiChart metrics={data.metrics} />
              </div>
              <AlertsPanel alerts={data.alerts} onAcknowledge={handleAcknowledge} />
            </section>

            {/* Linha 3: rankings */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <CampaignsRanking campaigns={engine?.aggregates ?? []} variant="best" />
              <CampaignsRanking campaigns={engine?.aggregates ?? []} variant="worst" />
              <PlacementsRanking placements={engine?.placementAggregates ?? []} />
            </section>

            {/* Tabela */}
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
              />
            </section>
          </TabsContent>

          <TabsContent value="integrations" className="mt-6">
            <IntegrationsPanel />
          </TabsContent>

          <TabsContent value="rules" className="mt-6">
            <RulesPanel rules={data.rules} onSaved={data.refresh} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default Index;
