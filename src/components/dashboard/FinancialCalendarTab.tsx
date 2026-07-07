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

interface SiteMetricDaily {
  date: string;
  revenue_native: number;
  impressions: number;
  currency?: string | null;
}

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const isoDateLocal = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const todayBRT = () => {
  const now = new Date();
  const brt = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return isoDateLocal(brt);
};

const parseISODateLocal = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export function FinancialCalendarTab() {
  const { filters } = useDashboardFilters();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-12
  const [regenerating, setRegenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; currentDate: string } | null>(null);

  const monthStart = useMemo(() => `${year}-${String(month).padStart(2, "0")}-01`, [year, month]);
  const monthEnd = useMemo(() => {
    const d = new Date(year, month, 0); // último dia do mês
    return isoDateLocal(d);
  }, [year, month]);

  const snapshotsQuery = useQuery({
    queryKey: ["dfs", filters.siteId, monthStart, monthEnd],
    enabled: filters.siteId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_financial_snapshots")
        .select("*")
        .eq("site_id", filters.siteId)
        .gte("date", monthStart)
        .lte("date", monthEnd)
        .order("date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as Snapshot[];
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });

  const siteMetricsQuery = useQuery({
    queryKey: ["calendar-site-metrics", filters.siteId, monthStart, monthEnd],
    enabled: filters.siteId !== "all",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("site_metrics_daily")
        .select("date, revenue_native, impressions, currency")
        .eq("site_id", filters.siteId)
        .gte("date", monthStart)
        .lte("date", monthEnd)
        .order("date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as SiteMetricDaily[];
    },
    staleTime: 30_000,
  });

  const todayStr = todayBRT();
  const rows = (snapshotsQuery.data ?? [])
    .filter((r) => r.date < todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));
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
    setProgress({ done: 0, total: 1, currentDate: date });
    try {
      const { error } = await supabase.functions.invoke("generate-daily-snapshot", {
        body: { date, site_id: filters.siteId, force: true },
      });
      if (error) throw error;
      setProgress({ done: 1, total: 1, currentDate: date });
      await snapshotsQuery.refetch();
      toast({ title: "Snapshot regenerado", description: date });
    } catch (e: any) {
      toast({ title: "Erro", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setRegenerating(false);
      setTimeout(() => setProgress(null), 800);
    }
  };

  const regenerateMonth = async () => {
    if (filters.siteId === "all") return;
    setRegenerating(true);
    try {
      const start = parseISODateLocal(monthStart);
      const end = parseISODateLocal(monthEnd);
      const todayStr = todayBRT();
      const dates: string[] = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const s = isoDateLocal(d);
        if (s >= todayStr) continue;
        dates.push(s);
      }
      if (dates.length === 0) {
        toast({ title: "Nada para regenerar", description: "Mês sem dias fechados." });
        return;
      }

      setProgress({ done: 0, total: dates.length, currentDate: dates[0] });

      // SÉRIE — um dia por vez para evitar quota GAM/Ads e garantir
      // que a UI só re-renderize APÓS TODOS os dias terminarem.
      let failures = 0;
      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        setProgress({ done: i, total: dates.length, currentDate: date });
        try {
          const { error } = await supabase.functions.invoke("generate-daily-snapshot", {
            body: { date, site_id: filters.siteId, force: true },
          });
          if (error) failures++;
        } catch {
          failures++;
        }
      }
      setProgress({ done: dates.length, total: dates.length, currentDate: dates[dates.length - 1] });

      // Só agora recarrega a grade — sem re-renders parciais durante o loop.
      await snapshotsQuery.refetch();
      await siteMetricsQuery.refetch();

      toast({
        title: "Atualização concluída",
        description: failures === 0
          ? `${dates.length} dia(s) regenerados.`
          : `${dates.length - failures} de ${dates.length} dia(s) atualizados. ${failures} falharam.`,
        variant: failures > 0 && failures === dates.length ? "destructive" : "default",
      });
    } catch (e: any) {
      toast({ title: "Erro", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setRegenerating(false);
      setTimeout(() => setProgress(null), 1200);
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
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <CalendarDays className="h-10 w-10 mx-auto mb-3 opacity-50" />
          Selecione um site no topo para ver o calendário financeiro.
        </CardContent>
      </Card>
    );
  }

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
                Regenera dia a dia (Google Ads + GAM) e só atualiza a grade quando todos os dias terminam.
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
              <Button variant="outline" size="sm" onClick={() => regenerateMonth()} disabled={regenerating}>
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
                    const dt = parseISODateLocal(r.date);
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
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{(String(r.revenue_currency ?? "BRL").toUpperCase() === "USD" ? fmtUSD : fmtBRL)(Number(r.gross_revenue))}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{(String(r.revenue_currency ?? "BRL").toUpperCase() === "USD" ? fmtUSD : fmtBRL)(Number(r.net_revenue))}</td>
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
                            disabled={regenerating}
                            onClick={() => regenerate(r.date)}
                            title="Regenerar este dia"
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
                    <td className="px-2 py-2 text-right font-mono">{fmtRev(totals.gross)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmtRev(totals.net)}</td>
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
            <Badge variant="outline">Snapshot recalculado pelo GAM</Badge>
            <Badge variant="outline">Cron diário 04:00 BRT</Badge>
            <Badge variant="outline">Receita já com rev share</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
