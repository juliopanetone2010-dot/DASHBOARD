import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarDays, RefreshCw, TrendingUp, TrendingDown, Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDashboardFilters } from "@/contexts/FilterContext";
import { fmtCurrency, fmtPercent, fmtNumber, fmtUSD, fmtBRL } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface Snapshot {
  id: string;
  site_id: string;
  date: string;
  google_ads_cost: number;
  facebook_ads_cost: number;
  other_cost: number;
  total_cost: number;
  gross_revenue: number;
  net_revenue: number;
  revenue_after_revshare: number;
  liquid_profit: number;
  profit_margin_pct: number;
  ecpm: number;
  viewability: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue_currency?: string | null;
}

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

export function FinancialCalendarTab() {
  const { filters } = useDashboardFilters();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-12
  const [regenerating, setRegenerating] = useState(false);

  const monthStart = useMemo(() => `${year}-${String(month).padStart(2, "0")}-01`, [year, month]);
  const monthEnd = useMemo(() => {
    const d = new Date(year, month, 0);
    return d.toISOString().slice(0, 10);
  }, [year, month]);

  const usdBrl = 5; // não utilizado no fluxo simples; mantido pra compatibilidade

  // Fonte: daily_financial_snapshots (comportamento original).
  // - Site específico: filtra por site_id
  // - "Todos os sites": agrega as snapshots de todos os sites por data
  const snapshotsQuery = useQuery({
    queryKey: ["dfs-calendar", filters.siteId, monthStart, monthEnd],
    queryFn: async () => {
      let q = supabase
        .from("daily_financial_snapshots")
        .select("*")
        .gte("date", monthStart)
        .lte("date", monthEnd)
        .order("date", { ascending: true })
        .limit(10000);
      if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as unknown as Snapshot[];
      if (filters.siteId !== "all") return rows;

      // Agrega por data quando "Todos os sites"
      const byDate = new Map<string, Snapshot>();
      for (const r of rows) {
        let m = byDate.get(r.date);
        if (!m) {
          m = {
            id: r.date, site_id: "all", date: r.date,
            google_ads_cost: 0, facebook_ads_cost: 0, other_cost: 0, total_cost: 0,
            gross_revenue: 0, net_revenue: 0, revenue_after_revshare: 0,
            liquid_profit: 0, profit_margin_pct: 0,
            ecpm: 0, viewability: 0, impressions: 0, clicks: 0, conversions: 0,
            revenue_currency: "BRL",
          };
          byDate.set(r.date, m);
        }
        m.google_ads_cost += Number(r.google_ads_cost) || 0;
        m.facebook_ads_cost += Number(r.facebook_ads_cost) || 0;
        m.other_cost += Number(r.other_cost) || 0;
        m.total_cost += Number(r.total_cost) || 0;
        m.gross_revenue += Number(r.gross_revenue) || 0;
        m.net_revenue += Number(r.net_revenue) || 0;
        m.revenue_after_revshare += Number(r.revenue_after_revshare) || 0;
        m.liquid_profit += Number(r.liquid_profit) || 0;
        m.impressions += Number(r.impressions) || 0;
        m.clicks += Number(r.clicks) || 0;
        m.conversions += Number(r.conversions) || 0;
      }
      for (const m of byDate.values()) {
        m.profit_margin_pct = m.net_revenue > 0 ? (m.liquid_profit / m.net_revenue) * 100 : 0;
        m.ecpm = m.impressions > 0 ? (m.net_revenue / m.impressions) * 1000 : 0;
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    },
  });






  const todayStr = new Date().toISOString().slice(0, 10);
  const rows = (snapshotsQuery.data ?? []).filter((r) => r.date < todayStr);
  const totals = useMemo(() => {
    return rows.reduce(
      (a, r) => ({
        google: a.google + Number(r.google_ads_cost || 0),
        cost: a.cost + Number(r.total_cost || 0),
        gross: a.gross + Number(r.gross_revenue || 0),
        net: a.net + Number(r.net_revenue || 0),
        profit: a.profit + Number(r.liquid_profit || 0),
        impressions: a.impressions + Number(r.impressions || 0),
        ecpmWeighted: a.ecpmWeighted + Number(r.ecpm || 0) * Number(r.impressions || 0),
      }),
      { google: 0, cost: 0, gross: 0, net: 0, profit: 0, impressions: 0, ecpmWeighted: 0 },
    );
  }, [rows]);

  const totalRoi = totals.cost > 0 ? ((totals.profit / totals.cost) * 100) : 0;
  const totalEcpm = totals.impressions > 0 ? totals.ecpmWeighted / totals.impressions : 0;
  const revCurrency = (rows.find((r) => r.revenue_currency)?.revenue_currency ?? "BRL").toUpperCase();
  const fmtRev = (v: number) => (revCurrency === "USD" ? fmtUSD(v) : fmtBRL(v));

  const regenerate = async (date: string) => {
    if (filters.siteId === "all") return;
    setRegenerating(true);
    try {
      const { error } = await supabase.functions.invoke("generate-daily-snapshot", {
        body: { date, site_id: filters.siteId, force: true },
      });
      if (error) throw error;
      toast({ title: "Snapshot regenerado", description: date });
      snapshotsQuery.refetch();
    } catch (e: any) {
      toast({ title: "Erro", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setRegenerating(false);
    }
  };

  const regenerateMonth = async () => {
    if (filters.siteId === "all") return;
    setRegenerating(true);
    try {
      const start = new Date(monthStart);
      const end = new Date(monthEnd);
      const todayStr = new Date().toISOString().slice(0, 10);
      const dates: string[] = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const s = d.toISOString().slice(0, 10);
        if (s < todayStr) dates.push(s);
      }
      for (const date of dates) {
        await supabase.functions.invoke("generate-daily-snapshot", {
          body: { date, site_id: filters.siteId, force: true },
        });
      }
      toast({ title: "Mês regenerado", description: `${dates.length} dias` });
      snapshotsQuery.refetch();
    } catch (e: any) {
      toast({ title: "Erro", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setRegenerating(false);
    }
  };

  const exportCsv = () => {
    const header = ["Data","Google Ads","Custo Total","Receita Bruta","Receita Líquida","Lucro","ROI %","eCPM","Viewability %","Impressões","Cliques","Conversões"];
    const lines = [header.join(",")];
    for (const r of rows) {
      const roi = r.total_cost > 0 ? (r.liquid_profit / r.total_cost) * 100 : 0;
      lines.push([
        r.date, r.google_ads_cost, r.total_cost,
        r.gross_revenue, r.net_revenue, r.liquid_profit, roi.toFixed(2),
        r.ecpm, r.viewability, r.impressions, r.clicks, r.conversions,
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `financeiro-${year}-${String(month).padStart(2,"0")}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // Limite mínimo: Maio/2026
  const MIN_YEAR = 2026;
  const MIN_MONTH = 5;
  const years = useMemo(() => {
    const arr: number[] = [];
    for (let y = today.getFullYear(); y >= MIN_YEAR; y--) arr.push(y);
    return arr;
  }, []);
  const availableMonths = useMemo(() => {
    return MONTHS_PT.map((m, i) => ({ label: m, value: i + 1 }))
      .filter(({ value }) => year > MIN_YEAR || value >= MIN_MONTH);
  }, [year]);

  if (filters.siteId === "all") {
    // permitido: aba consolida todos os sites em BRL
  }

  // currency display: forçamos BRL quando "todos os sites" (consolidação)
  const revCurrencyDisplay = filters.siteId === "all" ? "BRL" : revCurrency;
  const fmtRevDisplay = (v: number) => (revCurrencyDisplay === "USD" ? fmtUSD(v) : fmtBRL(v));


  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5" /> Calendário Financeiro
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Snapshots imutáveis fechados às 04:00 BRT do dia seguinte. Valores não recalculam.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {availableMonths.map(({ label, value }) => <SelectItem key={value} value={String(value)}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger className="h-9 w-[100px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
                <Download className="h-3.5 w-3.5 mr-1" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={regenerateMonth} disabled={regenerating || filters.siteId === "all"} title={filters.siteId === "all" ? "Selecione um site para regenerar" : ""}>
                <RefreshCw className={cn("h-3.5 w-3.5 mr-1", regenerating && "animate-spin")} />
                Regenerar mês
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {snapshotsQuery.isLoading ? (
            <div className="py-8 text-center text-muted-foreground text-sm">Carregando…</div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              Nenhum snapshot para {MONTHS_PT[month - 1]}/{year}. Use "Regenerar mês" para gerar.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground uppercase tracking-wider">
                  <tr>
                    <th className="px-2 py-2 text-left font-semibold">Data</th>
                    <th className="px-2 py-2 text-right font-semibold">Google Ads</th>
                    <th className="px-2 py-2 text-right font-semibold">Custo Total</th>
                    <th className="px-2 py-2 text-right font-semibold">Rec. Bruta</th>
                    <th className="px-2 py-2 text-right font-semibold">Rec. Líquida</th>
                    <th className="px-2 py-2 text-right font-semibold">Lucro</th>
                    <th className="px-2 py-2 text-right font-semibold">ROI</th>
                    
                    <th className="px-2 py-2 text-right font-semibold">eCPM</th>
                    <th className="px-2 py-2 text-right font-semibold">View.</th>
                    <th className="px-2 py-2 text-right font-semibold">Impr.</th>
                    <th className="px-2 py-2 text-center font-semibold w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const profit = Number(r.liquid_profit);
                    const positive = profit >= 0;
                    const roi = r.total_cost > 0 ? (profit / r.total_cost) * 100 : 0;
                    const dt = new Date(r.date + "T00:00:00");
                    const wk = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"][dt.getDay()];
                    return (
                      <tr key={r.id} className={cn(
                        "border-t border-border/50 hover:bg-muted/30 transition-colors",
                        positive ? "bg-success/5" : "bg-destructive/5",
                      )}>
                        <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                          <span className="text-muted-foreground">{wk}</span>{" "}
                          <span className="font-semibold">{r.date.slice(8, 10)}/{r.date.slice(5, 7)}</span>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtCurrency(Number(r.google_ads_cost))}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-medium">{fmtCurrency(Number(r.total_cost))}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{filters.siteId === "all" ? fmtBRL(Number(r.gross_revenue)) : (String(r.revenue_currency ?? "BRL").toUpperCase() === "USD" ? fmtUSD : fmtBRL)(Number(r.gross_revenue))}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{filters.siteId === "all" ? fmtBRL(Number(r.net_revenue)) : (String(r.revenue_currency ?? "BRL").toUpperCase() === "USD" ? fmtUSD : fmtBRL)(Number(r.net_revenue))}</td>
                        <td className={cn(
                          "px-2 py-1.5 text-right font-mono font-bold",
                          positive ? "text-success" : "text-destructive",
                        )}>
                          {positive ? <TrendingUp className="inline h-3 w-3 mr-0.5" /> : <TrendingDown className="inline h-3 w-3 mr-0.5" />}
                          {fmtCurrency(profit)}
                        </td>
                        <td className={cn("px-2 py-1.5 text-right font-mono", positive ? "text-success" : "text-destructive")}>
                          {fmtPercent(roi)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">{fmtCurrency(Number(r.ecpm))}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{Number(r.viewability).toFixed(1)}%</td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{fmtNumber(Number(r.impressions))}</td>
                        <td className="px-2 py-1.5 text-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={regenerating || filters.siteId === "all"}
                            onClick={() => regenerate(r.date)}
                            title={filters.siteId === "all" ? "Selecione um site para regenerar" : "Regenerar este dia"}
                          >
                            <RefreshCw className="h-3 w-3" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-muted/60 font-semibold">
                  <tr className="border-t-2 border-border">
                    <td className="px-2 py-2 uppercase text-xs">Total {MONTHS_PT[month - 1]}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmtCurrency(totals.google)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmtCurrency(totals.cost)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmtRevDisplay(totals.gross)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmtRevDisplay(totals.net)}</td>
                    <td className={cn(
                      "px-2 py-2 text-right font-mono font-bold",
                      totals.profit >= 0 ? "text-success" : "text-destructive",
                    )}>{fmtCurrency(totals.profit)}</td>
                    <td className={cn("px-2 py-2 text-right font-mono", totalRoi >= 0 ? "text-success" : "text-destructive")}>{fmtPercent(totalRoi)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmtCurrency(totalEcpm)}</td>
                    <td className="px-2 py-2 text-right font-mono">—</td>
                    <td className="px-2 py-2 text-right font-mono">{fmtNumber(totals.impressions)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-3 text-xs">
            <Badge variant="outline">Snapshot fixo (não recalcula)</Badge>
            <Badge variant="outline">Cron diário 04:00 BRT</Badge>
            <Badge variant="outline">Receita já com rev share</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
