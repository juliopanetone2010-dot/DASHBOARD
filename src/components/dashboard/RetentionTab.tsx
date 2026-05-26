import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RefreshCw, Repeat, Wallet, TrendingUp, CalendarIcon, Zap, ShieldCheck, AlertTriangle, Bug, ChevronDown } from "lucide-react";
import { fmtUSD } from "@/lib/format";
import { supabase } from "@/integrations/supabase/client";
import type { Campaign } from "@/types/domain";
import { MetricCard } from "./MetricCard";
import { useDashboardFilters } from "@/contexts/FilterContext";
import { DATE_PRESETS, presetFromRange, type DatePresetKey } from "@/components/dashboard/FilterBar";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/use-toast";

interface PushRow {
  id: string;
  date: string;
  url: string;
  normalized_url: string;
  utm_source: string;
  revenue_usd: number;
  impressions: number;
  ecpm: number;
}

interface UnattribRow {
  id: string;
  date: string;
  revenue_usd: number;
  impressions: number;
  reason: string;
}

interface SyncResult {
  ok: boolean;
  inserted?: number;
  unattributed?: number;
  debug?: {
    totalRowsFromGam: number;
    matchedPush: number;
    ignoredNoPush: number;
    aggregateRows: number;
    duplicates: number;
    ecpmAnomalies: number;
    sampleIgnored: string[];
    sampleMatched: string[];
  };
}

interface Props {
  campaigns: Campaign[]; // não usado na nova engine, mantido p/ compat
}

export function RetentionTab(_props: Props) {
  const { range: globalRange, filters } = useDashboardFilters();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);

  const [localRange, setLocalRange] = useState<{ from: string; to: string } | null>(null);
  const range = localRange ?? globalRange;
  const activePreset: DatePresetKey | null = presetFromRange(range.from, range.to);
  const applyPreset = (key: DatePresetKey) => {
    const p = DATE_PRESETS.find((x) => x.key === key);
    if (p) setLocalRange(p.range());
  };

  const siteId = filters.siteId;
  const enabled = siteId && siteId !== "all";

  const queryKey = useMemo(
    () => ["push-retention", range.from, range.to, siteId],
    [range.from, range.to, siteId],
  );

  const rowsQuery = useQuery<PushRow[]>({
    queryKey,
    enabled: !!enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("push_retention_revenue")
        .select("id, date, url, normalized_url, utm_source, revenue_usd, impressions, ecpm")
        .eq("site_id", siteId)
        .gte("date", range.from)
        .lte("date", range.to)
        .order("revenue_usd", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as PushRow[];
    },
    staleTime: 30_000,
  });

  const unattribQuery = useQuery<UnattribRow[]>({
    queryKey: ["push-unattrib", range.from, range.to, siteId],
    enabled: !!enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("unattributed_push_revenue")
        .select("id, date, revenue_usd, impressions, reason")
        .eq("site_id", siteId)
        .gte("date", range.from)
        .lte("date", range.to);
      if (error) throw error;
      return (data ?? []) as UnattribRow[];
    },
    staleTime: 30_000,
  });

  const rows = rowsQuery.data ?? [];
  const unattrib = unattribQuery.data ?? [];
  const loading = rowsQuery.isFetching || syncing;

  const totals = useMemo(() => {
    const push = rows.reduce((s, r) => s + Number(r.revenue_usd || 0), 0);
    const impressions = rows.reduce((s, r) => s + Number(r.impressions || 0), 0);
    const unattribTotal = unattrib.reduce((s, r) => s + Number(r.revenue_usd || 0), 0);
    const ecpm = impressions > 0 ? (push / impressions) * 1000 : 0;
    return { push, impressions, unattribTotal, ecpm };
  }, [rows, unattrib]);

  const load = async () => {
    if (!enabled) {
      toast({ title: "Selecione um site no topo", variant: "destructive" });
      return;
    }
    setSyncing(true);
    setLastSync(null);
    try {
      const { data, error } = await supabase.functions.invoke<SyncResult>("gam-sync-push-retention", {
        body: { site_id: siteId, from: range.from, to: range.to },
      });
      if (error) throw error;
      setLastSync(data ?? null);
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["push-unattrib", range.from, range.to, siteId] });
      toast({
        title: "Sincronização concluída",
        description: `${data?.inserted ?? 0} URLs push • ${data?.unattributed ?? 0} agregadas isoladas`,
      });
    } catch (e: any) {
      toast({ title: "Erro ao sincronizar", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  const fromDate = range.from ? new Date(range.from + "T00:00:00") : undefined;
  const toDate = range.to ? new Date(range.to + "T00:00:00") : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            Retenção / Push
            <Badge variant="outline" className="text-xs">utm_source=push (estrito)</Badge>
          </h2>
          <p className="text-xs text-muted-foreground">
            Receita do GAM por URL exata, filtrada estritamente por <code>utm_source=push</code>. Bate com o relatório manual.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            {range.from} → {range.to}
          </Badge>
          {localRange && (
            <Button size="sm" variant="ghost" onClick={() => setLocalRange(null)} className="h-8 text-xs">
              Período do dashboard
            </Button>
          )}
          <Button size="sm" variant="default" onClick={load} disabled={loading || !enabled} className="gap-2">
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Sincronizar GAM
          </Button>
        </div>
      </div>

      {!enabled && (
        <Card className="border-amber-500/50">
          <CardContent className="py-6 text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Selecione um site específico no topo do dashboard para usar a engine Push.
          </CardContent>
        </Card>
      )}

      <div className="rounded-xl border border-border bg-card p-3 shadow-elegant">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground pr-1">
            <Zap className="h-3.5 w-3.5" /> Período
          </div>
          {DATE_PRESETS.map((p) => (
            <Button key={p.key} type="button" size="sm" variant={activePreset === p.key ? "default" : "outline"} onClick={() => applyPreset(p.key)} className="h-8">
              {p.label}
            </Button>
          ))}
          <div className="mx-2 h-6 w-px bg-border" />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={cn("h-8 gap-2", !fromDate && "text-muted-foreground")}>
                <CalendarIcon className="h-3.5 w-3.5" />
                {fromDate ? format(fromDate, "dd/MM/yy") : "De"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={fromDate} onSelect={(d) => d && setLocalRange({ from: format(d, "yyyy-MM-dd"), to: range.to })} initialFocus className={cn("p-3 pointer-events-auto")} />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={cn("h-8 gap-2", !toDate && "text-muted-foreground")}>
                <CalendarIcon className="h-3.5 w-3.5" />
                {toDate ? format(toDate, "dd/MM/yy") : "Até"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={toDate} onSelect={(d) => d && setLocalRange({ from: range.from, to: format(d, "yyyy-MM-dd") })} initialFocus className={cn("p-3 pointer-events-auto")} />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Receita Push (USD)" value={fmtUSD(totals.push)} icon={Repeat} variant="primary" hint={`${rows.length} URL(s) únicas`} />
        <MetricCard label="Impressões Push" value={totals.impressions.toLocaleString("pt-BR")} icon={Wallet} />
        <MetricCard label="eCPM médio" value={`$${totals.ecpm.toFixed(2)}`} icon={TrendingUp} variant="success" hint="(receita / impressões) × 1000" />
        <MetricCard
          label="Não atribuído (agregadas)"
          value={fmtUSD(totals.unattribTotal)}
          icon={AlertTriangle}
          hint={`${unattrib.length} linha(s) isoladas — não contamina por-URL`}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>URLs Push ({range.from} → {range.to})</span>
            <Badge variant="outline">{rows.length} URL(s)</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Sem dados. Clique em <b>Sincronizar GAM</b> para puxar as URLs do período.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>URL</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead className="text-right">Impressões</TableHead>
                    <TableHead className="text-right">Receita (USD)</TableHead>
                    <TableHead className="text-right">eCPM</TableHead>
                    <TableHead>utm</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const calcEcpm = r.impressions > 0 ? (Number(r.revenue_usd) / r.impressions) * 1000 : 0;
                    const matches = Math.abs(calcEcpm - Number(r.ecpm)) < 0.01;
                    const anomaly = calcEcpm > 1000 || (Number(r.revenue_usd) > 0 && calcEcpm < 0.01);
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="max-w-[420px]">
                          <div className="font-mono text-xs truncate" title={r.url}>{r.normalized_url}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.date}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.impressions.toLocaleString("pt-BR")}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{fmtUSD(Number(r.revenue_usd))}</TableCell>
                        <TableCell className="text-right tabular-nums">${calcEcpm.toFixed(2)}</TableCell>
                        <TableCell><Badge variant="outline" className="text-xs">{r.utm_source}</Badge></TableCell>
                        <TableCell className="text-right">
                          {anomaly ? (
                            <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" />ANOMALY</Badge>
                          ) : matches ? (
                            <Badge variant="default" className="gap-1 bg-emerald-500/20 text-emerald-600 hover:bg-emerald-500/30 border-emerald-500/40">
                              <ShieldCheck className="h-3 w-3" />VERIFIED
                            </Badge>
                          ) : (
                            <Badge variant="outline">drift</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {lastSync?.debug && (
        <Collapsible>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                <CardTitle className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2"><Bug className="h-4 w-4" /> Debug do último sync</span>
                  <ChevronDown className="h-4 w-4" />
                </CardTitle>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-3 text-xs font-mono">
                <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                  <DebugStat label="GAM rows" value={lastSync.debug.totalRowsFromGam} />
                  <DebugStat label="Matched push" value={lastSync.debug.matchedPush} variant="success" />
                  <DebugStat label="Ignored ≠push" value={lastSync.debug.ignoredNoPush} />
                  <DebugStat label="Aggregate" value={lastSync.debug.aggregateRows} variant="warn" />
                  <DebugStat label="Duplicates" value={lastSync.debug.duplicates} />
                  <DebugStat label="eCPM anomalies" value={lastSync.debug.ecpmAnomalies} variant={lastSync.debug.ecpmAnomalies ? "warn" : undefined} />
                </div>
                {lastSync.debug.sampleMatched.length > 0 && (
                  <div>
                    <div className="font-semibold mb-1">Amostra MATCHED:</div>
                    {lastSync.debug.sampleMatched.map((s, i) => <div key={i} className="text-muted-foreground">• {s}</div>)}
                  </div>
                )}
                {lastSync.debug.sampleIgnored.length > 0 && (
                  <div>
                    <div className="font-semibold mb-1">Amostra IGNORED:</div>
                    {lastSync.debug.sampleIgnored.map((s, i) => <div key={i} className="text-muted-foreground">• {s}</div>)}
                  </div>
                )}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      <p className="text-xs text-muted-foreground">
        ⓘ Linhas agregadas (sem URL exata) são isoladas em <code>unattributed_push_revenue</code> e não contaminam o eCPM nem a tabela por URL. Aggregate contamination = 0%.
      </p>
    </div>
  );
}

function DebugStat({ label, value, variant }: { label: string; value: number; variant?: "success" | "warn" }) {
  const cls = variant === "success" ? "text-emerald-500" : variant === "warn" ? "text-amber-500" : "text-foreground";
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-bold tabular-nums", cls)}>{value.toLocaleString("pt-BR")}</div>
    </div>
  );
}
