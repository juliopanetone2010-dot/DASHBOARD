import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  DollarSign,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { fmtCurrency, fmtPercent } from "@/lib/format";
import {
  deleteCampaign,
  fetchCampaigns,
  upsertCampaign,
} from "@/services/campaignsApi";
import type { Campaign } from "@/types/campaign";
import { withMetrics } from "@/types/campaign";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { CampaignsTable } from "@/components/dashboard/CampaignsTable";
import { CampaignFormDialog } from "@/components/dashboard/CampaignFormDialog";

const Index = () => {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterCampaign, setFilterCampaign] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchCampaigns();
      setCampaigns(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleRefresh = async () => {
    await load();
    toast({ title: "Dados atualizados", description: "Métricas recalculadas com sucesso." });
  };

  const handleUpsert = async (c: Campaign) => {
    await upsertCampaign(c);
    await load();
    toast({ title: "Campanha salva", description: c.name });
  };

  const handleDelete = async (id: string) => {
    await deleteCampaign(id);
    await load();
    toast({ title: "Campanha removida" });
  };

  const filtered = useMemo(() => {
    return campaigns
      .filter((c) => (filterCampaign === "all" ? true : c.campaignId === filterCampaign))
      .filter((c) => (dateFrom ? c.date >= dateFrom : true))
      .filter((c) => (dateTo ? c.date <= dateTo : true))
      .map(withMetrics)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [campaigns, filterCampaign, dateFrom, dateTo]);

  const totals = useMemo(() => {
    const spend = filtered.reduce((s, c) => s + c.spend, 0);
    const revenue = filtered.reduce((s, c) => s + c.revenue, 0);
    const profit = revenue - spend;
    const roi = spend > 0 ? (profit / spend) * 100 : 0;
    return { spend, revenue, profit, roi };
  }, [filtered]);

  const profitPositive = totals.profit >= 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="container flex flex-col md:flex-row md:items-center md:justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
              <BarChart3 className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">ROI Arbitrage Dashboard</h1>
              <p className="text-xs text-muted-foreground">Google Ads × Ad Manager</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleRefresh} disabled={loading} className="gap-2">
              <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Atualizar
            </Button>
            <CampaignFormDialog onSubmit={handleUpsert} />
          </div>
        </div>
      </header>

      <main className="container py-8 space-y-8">
        {/* Metric cards */}
        <section aria-label="Métricas principais" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="Gasto (Google Ads)"
            value={fmtCurrency(totals.spend)}
            icon={Wallet}
            hint={`${filtered.length} campanha(s)`}
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
            label="ROI"
            value={fmtPercent(totals.roi)}
            icon={profitPositive ? TrendingUp : TrendingDown}
            variant={profitPositive ? "success" : "danger"}
            hint={profitPositive ? "Operação lucrativa" : "Operação no prejuízo"}
          />
        </section>

        {/* Filters */}
        <section className="rounded-xl border border-border bg-card p-4 shadow-soft">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">Campanha</Label>
              <Select value={filterCampaign} onValueChange={setFilterCampaign}>
                <SelectTrigger>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as campanhas</SelectItem>
                  {campaigns.map((c) => (
                    <SelectItem key={c.campaignId} value={c.campaignId}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="from">Data de</Label>
              <Input id="from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="to">Data até</Label>
              <Input id="to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                setFilterCampaign("all");
                setDateFrom("");
                setDateTo("");
              }}
            >
              Limpar filtros
            </Button>
          </div>
        </section>

        {/* Table */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Campanhas
            </h2>
            <span className="text-xs text-muted-foreground">{filtered.length} resultado(s)</span>
          </div>
          <CampaignsTable campaigns={filtered} onUpdate={handleUpsert} onDelete={handleDelete} />
        </section>

        <footer className="pt-4 pb-8 text-center text-xs text-muted-foreground">
          Estrutura pronta para integração futura com Google Ads API e Google Ad Manager API.
        </footer>
      </main>
    </div>
  );
};

export default Index;
