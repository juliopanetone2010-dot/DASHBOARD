import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useDashboardFilters } from "@/contexts/FilterContext";
import { fmtBRL, fmtPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NET_FACTOR } from "@/engine/rules";

interface CleanupLog {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  google_account_id: string | null;
  site_id: string | null;
  placements_removed_count: number;
  roi_before: number | null;
  cost_before: number | null;
  revenue_before: number | null;
  executed_at: string;
}

interface ImpactRow {
  log: CleanupLog;
  cost_after: number;
  revenue_after: number;
  roi_after: number;
  delta: number;
  classification: "up" | "down" | "neutral" | "pending";
  daysCovered: number;
}

const NEUTRAL_THRESHOLD = 5; // pp de ROI

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function CleanupImpactPanel({ fxUsdBrl }: { fxUsdBrl: number }) {
  const { filters } = useDashboardFilters();
  const [windowDays, setWindowDays] = useState(3);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<CleanupLog[]>([]);
  const [rows, setRows] = useState<ImpactRow[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      // Busca logs recentes (últimos 60 dias) respeitando site
      const since = new Date(Date.now() - 60 * 86400_000).toISOString();
      let q = supabase
        .from("placement_cleanup_logs")
        .select("id, campaign_id, campaign_name, google_account_id, site_id, placements_removed_count, roi_before, cost_before, revenue_before, executed_at")
        .gte("executed_at", since)
        .order("executed_at", { ascending: false })
        .limit(200);
      if (filters.siteId && filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
      const { data, error } = await q;
      if (error) throw error;
      const list = (data ?? []) as CleanupLog[];
      setLogs(list);

      if (list.length === 0) {
        setRows([]);
        return;
      }

      // Para cada log, agrega métricas em [executed_at+1, executed_at+windowDays] limitado a ontem
      const yesterday = new Date(Date.now() - 86400_000);
      const yesterdayIso = isoDate(yesterday);

      const out: ImpactRow[] = [];
      // Agrupa por campanha para reduzir queries
      const byCampaign = new Map<string, CleanupLog[]>();
      for (const l of list) {
        const arr = byCampaign.get(l.campaign_id) ?? [];
        arr.push(l);
        byCampaign.set(l.campaign_id, arr);
      }

      for (const [campaignId, campLogs] of byCampaign) {
        // Define a janela mínima e máxima de datas necessárias
        const minFromDate = new Date(Math.min(...campLogs.map((l) => new Date(l.executed_at).getTime() + 86400_000)));
        const maxToDate = new Date(Math.max(...campLogs.map((l) => Math.min(new Date(l.executed_at).getTime() + windowDays * 86400_000, yesterday.getTime()))));
        if (minFromDate > maxToDate) continue;
        const { data: metrics } = await supabase
          .from("daily_metrics")
          .select("date, spend, revenue, profit")
          .eq("campaign_id", campaignId)
          .gte("date", isoDate(minFromDate))
          .lte("date", isoDate(maxToDate))
          .limit(2000);
        const arr = metrics ?? [];

        for (const log of campLogs) {
          const start = new Date(new Date(log.executed_at).getTime() + 86400_000);
          const endTs = Math.min(new Date(log.executed_at).getTime() + windowDays * 86400_000, yesterday.getTime());
          if (start.getTime() > endTs) continue;
          const fromIso = isoDate(start);
          const toIso = isoDate(new Date(endTs));
          let cost = 0;
          let grossProfit = 0;
          let grossRevBrl = 0;
          for (const m of arr) {
            if (m.date < fromIso || m.date > toIso) continue;
            const sp = Number(m.spend ?? 0);
            const pr = Number(m.profit ?? 0);
            cost += sp;
            grossProfit += pr;
            grossRevBrl += sp + pr;
          }
          const revenue_after = grossRevBrl * NET_FACTOR;
          const profit_after = revenue_after - cost;
          const roi_after = cost > 0 ? (profit_after / cost) * 100 : 0;
          const roi_before = Number(log.roi_before ?? 0);
          const delta = roi_after - roi_before;
          const classification: ImpactRow["classification"] =
            Math.abs(delta) < NEUTRAL_THRESHOLD ? "neutral" : delta > 0 ? "up" : "down";
          out.push({
            log,
            cost_after: cost,
            revenue_after,
            roi_after,
            delta,
            classification,
          });
        }
      }
      out.sort((a, b) => new Date(b.log.executed_at).getTime() - new Date(a.log.executed_at).getTime());
      setRows(out);
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filters.siteId, windowDays]);

  const summary = useMemo(() => {
    let up = 0, down = 0, neutral = 0;
    for (const r of rows) {
      if (r.classification === "up") up++;
      else if (r.classification === "down") down++;
      else neutral++;
    }
    return { up, down, neutral, total: rows.length };
  }, [rows]);

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <TrendingUp className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-[260px]">
          <div className="text-sm font-semibold">Impacto da limpeza de placements</div>
          <div className="text-xs text-muted-foreground">
            Compara ROI da campanha {windowDays} dias antes vs depois da limpeza. Considera dados até ontem. Só mostra limpezas do site selecionado.
          </div>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Janela:</span>
          {[2, 3, 5, 7].map((d) => (
            <button key={d} onClick={() => setWindowDays(d)}
              className={cn("text-[11px] rounded-md border px-2 py-1 transition-colors",
                windowDays === d ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted")}>
              {d}d
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <Badge className="bg-success-soft text-success border-success/20">🟢 {summary.up}</Badge>
          <Badge className="bg-danger-soft text-danger border-danger/20">🔴 {summary.down}</Badge>
          <Badge variant="outline">⚪ {summary.neutral}</Badge>
        </div>

        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <RefreshCw className="h-3.5 w-3.5 mr-2" />}
          Atualizar
        </Button>
      </div>

      <div className="overflow-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Campanha</TableHead>
              <TableHead className="text-right">Removidos</TableHead>
              <TableHead>Quando</TableHead>
              <TableHead className="text-right">ROI antes</TableHead>
              <TableHead className="text-right">ROI depois</TableHead>
              <TableHead className="text-right">Δ ROI</TableHead>
              <TableHead className="text-right">Custo antes → depois</TableHead>
              <TableHead className="text-right">Receita antes → depois</TableHead>
              <TableHead className="text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={9} className="text-center py-8"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando...</TableCell></TableRow>
            )}
            {!loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                Nenhuma limpeza recente para este site. Rode uma limpeza para começar a medir impacto.
              </TableCell></TableRow>
            )}
            {rows.map((r) => {
              const before = Number(r.log.roi_before ?? 0);
              const status = r.classification;
              return (
                <TableRow key={r.log.id}>
                  <TableCell className="font-medium text-sm max-w-[280px] truncate" title={r.log.campaign_name ?? r.log.campaign_id}>
                    {r.log.campaign_name ?? r.log.campaign_id}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Badge variant="destructive">{r.log.placements_removed_count}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(r.log.executed_at).toLocaleString("pt-BR")}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", before < 0 ? "text-danger" : "text-success")}>{fmtPercent(before)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", r.roi_after < 0 ? "text-danger" : "text-success")}>{fmtPercent(r.roi_after)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums font-semibold",
                    status === "up" ? "text-success" : status === "down" ? "text-danger" : "text-muted-foreground")}>
                    {r.delta >= 0 ? "+" : ""}{fmtPercent(r.delta)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {fmtBRL(Number(r.log.cost_before ?? 0))} → {fmtBRL(r.cost_after)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {fmtBRL(Number(r.log.revenue_before ?? 0))} → {fmtBRL(r.revenue_after)}
                  </TableCell>
                  <TableCell className="text-right">
                    {status === "up" && <Badge className="bg-success-soft text-success border-success/20"><TrendingUp className="h-3 w-3 mr-1" />Melhorou</Badge>}
                    {status === "down" && <Badge className="bg-danger-soft text-danger border-danger/20"><TrendingDown className="h-3 w-3 mr-1" />Piorou</Badge>}
                    {status === "neutral" && <Badge variant="outline"><Minus className="h-3 w-3 mr-1" />Neutro</Badge>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
