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
  const [windowDays, setWindowDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<CleanupLog[]>([]);
  const [rows, setRows] = useState<ImpactRow[]>([]);
  const [siteOverride, setSiteOverride] = useState<string>("");
  const [siteOptions, setSiteOptions] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    supabase.from("sites").select("id, name").order("name").then(({ data }) => {
      setSiteOptions((data ?? []) as any);
    });
  }, []);

  const effectiveSiteId = siteOverride || filters.siteId;

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
      if (effectiveSiteId && effectiveSiteId !== "all") q = q.eq("site_id", effectiveSiteId);
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
        // Janela completa: [exec - windowDays, exec - 1] ∪ [exec + 1, min(exec + windowDays, ontem)]
        const minFromDate = new Date(Math.min(...campLogs.map((l) => new Date(l.executed_at).getTime() - windowDays * 86400_000)));
        const maxToDate = new Date(Math.max(...campLogs.map((l) => Math.min(new Date(l.executed_at).getTime() + windowDays * 86400_000, yesterday.getTime()))));
        let arr: any[] = [];
        if (minFromDate <= maxToDate) {
          const { data: metrics } = await supabase
            .from("daily_metrics")
            .select("date, spend, revenue, profit")
            .eq("campaign_id", campaignId)
            .gte("date", isoDate(minFromDate))
            .lte("date", isoDate(maxToDate))
            .limit(2000);
          arr = metrics ?? [];
        }

        const aggregate = (fromIso: string, toIso: string) => {
          let cost = 0, grossRevBrl = 0;
          for (const m of arr) {
            if (m.date < fromIso || m.date > toIso) continue;
            const sp = Number(m.spend ?? 0);
            const pr = Number(m.profit ?? 0);
            cost += sp;
            grossRevBrl += sp + pr;
          }
          const revenue = grossRevBrl * NET_FACTOR;
          const roi = cost > 0 ? ((revenue - cost) / cost) * 100 : 0;
          return { cost, revenue, roi };
        };

        for (const log of campLogs) {
          const execTs = new Date(log.executed_at).getTime();
          // ANTES: [exec - windowDays, exec - 1d]
          const beforeFrom = isoDate(new Date(execTs - windowDays * 86400_000));
          const beforeTo = isoDate(new Date(execTs - 86400_000));
          const before = aggregate(beforeFrom, beforeTo);

          // DEPOIS (simétrico): [exec + 1d, exec + windowDays] — só classifica se janela completa
          const afterStartTs = execTs + 86400_000;
          const afterEndTs = execTs + windowDays * 86400_000;
          const availableEndTs = Math.min(afterEndTs, yesterday.getTime());
          const hasAnyAfter = afterStartTs <= availableEndTs;
          const after = hasAnyAfter
            ? aggregate(isoDate(new Date(afterStartTs)), isoDate(new Date(availableEndTs)))
            : { cost: 0, revenue: 0, roi: 0 };
          const daysCovered = hasAnyAfter ? Math.floor((availableEndTs - afterStartTs) / 86400_000) + 1 : 0;
          const isComplete = daysCovered >= windowDays;

          const delta = after.roi - before.roi;
          let classification: ImpactRow["classification"];
          if (!isComplete) classification = "pending";
          else if (Math.abs(delta) < NEUTRAL_THRESHOLD) classification = "neutral";
          else if (delta > 0) classification = "up";
          else classification = "down";

          out.push({
            log: { ...log, roi_before: before.cost > 0 ? before.roi : log.roi_before, cost_before: before.cost, revenue_before: before.revenue },
            cost_after: after.cost,
            revenue_after: after.revenue,
            roi_after: after.roi,
            delta,
            classification,
            daysCovered,
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

  useEffect(() => { load(); }, [effectiveSiteId, windowDays]);

  const summary = useMemo(() => {
    let up = 0, down = 0, neutral = 0, pending = 0;
    for (const r of rows) {
      if (r.classification === "up") up++;
      else if (r.classification === "down") down++;
      else if (r.classification === "pending") pending++;
      else neutral++;
    }
    return { up, down, neutral, pending, total: rows.length };
  }, [rows]);

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <TrendingUp className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-[260px]">
          <div className="text-sm font-semibold">Impacto da limpeza de placements</div>
          <div className="text-xs text-muted-foreground">
            Compara ROI {windowDays}d antes vs {windowDays}d depois da limpeza (janelas simétricas). Só classifica quando há dados completos pós-limpeza.
          </div>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Janela:</span>
          {[{v:1,l:"1d"},{v:2,l:"2d"},{v:3,l:"3d"},{v:7,l:"7d"},{v:15,l:"15d"},{v:30,l:"30d"}].map((d) => (
            <button key={d.v} onClick={() => setWindowDays(d.v)}
              className={cn("text-[11px] rounded-md border px-2 py-1 transition-colors",
                windowDays === d.v ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted")}>
              {d.l}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <Badge className="bg-success-soft text-success border-success/20">🟢 {summary.up}</Badge>
          <Badge className="bg-danger-soft text-danger border-danger/20">🔴 {summary.down}</Badge>
          <Badge variant="outline">⚪ {summary.neutral}</Badge>
          {summary.pending > 0 && <Badge variant="outline">⏳ {summary.pending}</Badge>}
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
                    {status === "pending" && (
                      <Badge variant="outline" title={`Faltam ${windowDays - r.daysCovered} dia(s) para completar a janela de ${windowDays}d`}>
                        ⏳ Faltam {windowDays - r.daysCovered}d
                      </Badge>
                    )}
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
