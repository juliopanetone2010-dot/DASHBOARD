import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RefreshCw, Repeat, Wallet, TrendingUp, CalendarIcon, Zap, AlertTriangle, ChevronDown, Globe, Bug } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  site_id: string;
  url: string;
  normalized_url: string;
  utm_source: string;
  revenue_usd: number;
  impressions: number;
  ecpm: number;
}

interface UnattribRow {
  id: string;
  site_id: string;
  date: string;
  revenue_usd: number;
  impressions: number;
  reason: string;
}

interface PushDebugReport {
  rowsReceivedGam?: number;
  totalRowsFromGam?: number;
  rowsWithUtmPush?: number;
  rowsInserted?: number;
  rowsIgnored?: number;
  ignoredNoPush?: number;
  aggregateRows?: number;
  duplicates?: number;
  discardReasons?: Record<string, number>;
  parserSources?: Record<string, number>;
  reportModes?: string[];
  sampleIgnored?: string[];
  sampleMatched?: string[];
}

interface PushDebugRun {
  site_id: string;
  ok: boolean;
  inserted?: number;
  unattributed?: number;
  error?: string;
  debug?: PushDebugReport;
}

interface Props {
  campaigns: Campaign[];
}

export function RetentionTab(_props: Props) {
  const { range: globalRange, filters } = useDashboardFilters();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [debugging, setDebugging] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugRuns, setDebugRuns] = useState<PushDebugRun[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const [localRange, setLocalRange] = useState<{ from: string; to: string } | null>(null);
  const range = localRange ?? globalRange;
  const activePreset: DatePresetKey | null = presetFromRange(range.from, range.to);
  const applyPreset = (key: DatePresetKey) => {
    const p = DATE_PRESETS.find((x) => x.key === key);
    if (p) setLocalRange(p.range());
  };

  const siteId = filters.siteId;
  const isAllSites = !siteId || siteId === "all";

  const queryKey = useMemo(
    () => ["push-retention", range.from, range.to, siteId ?? "all"],
    [range.from, range.to, siteId],
  );

  const sitesQuery = useQuery({
    queryKey: ["sites-lite"],
    queryFn: async () => {
      const { data, error } = await supabase.from("sites").select("id, name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
    staleTime: 60_000,
  });

  const rowsQuery = useQuery<PushRow[]>({
    queryKey,
    queryFn: async () => {
      let q = supabase
        .from("push_retention_revenue")
        .select("id, site_id, date, url, normalized_url, utm_source, revenue_usd, impressions, ecpm")
        .gte("date", range.from)
        .lte("date", range.to)
        .order("revenue_usd", { ascending: false })
        .limit(10000);
      if (!isAllSites) q = q.eq("site_id", siteId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as PushRow[];
    },
    staleTime: 30_000,
  });

  const unattribQuery = useQuery<UnattribRow[]>({
    queryKey: ["push-unattrib", range.from, range.to, siteId ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from("unattributed_push_revenue")
        .select("id, site_id, date, revenue_usd, impressions, reason")
        .gte("date", range.from)
        .lte("date", range.to);
      if (!isAllSites) q = q.eq("site_id", siteId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as UnattribRow[];
    },
    staleTime: 30_000,
  });

  const syncStateQuery = useQuery({
    queryKey: ["push-sync-state", siteId ?? "all"],
    queryFn: async () => {
      let q = supabase
        .from("sync_state")
        .select("site_id, last_started_at, last_finished_at, last_status, last_error, rows_synced")
        .eq("source", "gam-sync-push-retention")
        .order("last_finished_at", { ascending: false });
      if (!isAllSites) q = q.eq("site_id", siteId);
      const { data, error } = await q.limit(20);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30_000,
  });

  const rows = rowsQuery.data ?? [];
  const unattrib = unattribQuery.data ?? [];
  const loading = rowsQuery.isFetching || syncing;
  const siteName = (id: string) => sitesQuery.data?.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  // Detecta push tanto por utm_source quanto por marcadores na URL (?push, utm_medium=push, etc.)
  const isPushRow = (r: PushRow) => {
    const utm = (r.utm_source || "").toLowerCase().trim();
    if (utm === "push") return true;
    const u = (r.url || "").toLowerCase();
    return /[?&](utm_source|utm_medium|source|medium)=push\b/.test(u) || /[?&]push(=|&|$)/.test(u);
  };

  // Apenas push
  const pushRows = useMemo(() => rows.filter(isPushRow), [rows]);

  const byUtm = useMemo(() => {
    if (pushRows.length === 0) return [] as { utm: string; rows: PushRow[]; revenue: number; impressions: number }[];
    const revenue = pushRows.reduce((s, r) => s + Number(r.revenue_usd || 0), 0);
    const impressions = pushRows.reduce((s, r) => s + Number(r.impressions || 0), 0);
    return [{ utm: "push", rows: [...pushRows].sort((a, b) => Number(b.revenue_usd) - Number(a.revenue_usd)), revenue, impressions }];
  }, [pushRows]);

  const totals = useMemo(() => {
    const total = pushRows.reduce((s, r) => s + Number(r.revenue_usd || 0), 0);
    const impressions = pushRows.reduce((s, r) => s + Number(r.impressions || 0), 0);
    const unattribTotal = unattrib.reduce((s, r) => s + Number(r.revenue_usd || 0), 0);
    const ecpm = impressions > 0 ? (total / impressions) * 1000 : 0;
    return { total, impressions, push: total, unattribTotal, ecpm };
  }, [pushRows, unattrib]);

  const syncOne = async (sid: string) => {
    const { data, error } = await supabase.functions.invoke("gam-sync-push-retention", {
      body: { site_id: sid, from: range.from, to: range.to },
    });
    if (error) throw new Error(error.message ?? String(error));
    return data;
  };

  const load = async () => {
    setSyncing(true);
    try {
      const targets = isAllSites
        ? (sitesQuery.data ?? []).map((s) => s.id)
        : [siteId];
      if (!targets.length) {
        toast({ title: "Nenhum site disponível", variant: "destructive" });
        return;
      }
      setProgress({ done: 0, total: targets.length });
      let inserted = 0, unattributed = 0, errs = 0;
      for (let i = 0; i < targets.length; i++) {
        try {
          const r: any = await syncOne(targets[i] as string);
          inserted += r?.inserted ?? 0;
          unattributed += r?.unattributed ?? 0;
        } catch (e: any) {
          errs++;
          console.error("[push-sync] erro site", targets[i], e?.message);
        }
        setProgress({ done: i + 1, total: targets.length });
      }
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["push-unattrib", range.from, range.to, siteId ?? "all"] });
      await queryClient.invalidateQueries({ queryKey: ["push-sync-state"] });
      toast({
        title: "Sincronização concluída",
        description: `${targets.length} site(s) • ${inserted} URLs • ${unattributed} agregadas${errs ? ` • ${errs} erro(s)` : ""}`,
      });
    } finally {
      setSyncing(false);
      setProgress(null);
    }
  };

  const runDebug = async () => {
    setDebugging(true);
    setDebugOpen(true);
    setDebugRuns([]);
    try {
      const targets = isAllSites ? (sitesQuery.data ?? []).map((s) => s.id) : [siteId];
      const runs: PushDebugRun[] = [];
      for (const sid of targets.filter(Boolean) as string[]) {
        try {
          const r: any = await syncOne(sid);
          runs.push({ site_id: sid, ok: true, inserted: r?.inserted ?? 0, unattributed: r?.unattributed ?? 0, debug: r?.debug });
        } catch (e: any) {
          runs.push({ site_id: sid, ok: false, error: String(e?.message ?? e) });
        }
      }
      setDebugRuns(runs);
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["push-unattrib", range.from, range.to, siteId ?? "all"] });
      await queryClient.invalidateQueries({ queryKey: ["push-sync-state"] });
    } finally {
      setDebugging(false);
    }
  };

  const fromDate = range.from ? new Date(range.from + "T00:00:00") : undefined;
  const toDate = range.to ? new Date(range.to + "T00:00:00") : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            Retenção / UTM
            <Badge variant="outline" className="text-xs">
              {isAllSites ? <><Globe className="h-3 w-3 mr-1 inline" />todos os sites</> : siteName(siteId!)}
            </Badge>
          </h2>
          <p className="text-xs text-muted-foreground">
            Receita do GAM filtrada para <code>utm_source=push</code> (ou URLs marcadas como push), agrupada por URL exata.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">{range.from} → {range.to}</Badge>
          {localRange && (
            <Button size="sm" variant="ghost" onClick={() => setLocalRange(null)} className="h-8 text-xs">
              Período do dashboard
            </Button>
          )}
          <Button size="sm" variant="default" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {progress ? `Sincronizando ${progress.done}/${progress.total}` : `Sincronizar GAM${isAllSites ? " (todos)" : ""}`}
          </Button>
          <Button size="sm" variant="outline" onClick={runDebug} disabled={loading || debugging} className="gap-2">
            <Bug className={debugging ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
            Debug Push
          </Button>
        </div>
      </div>

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
        <MetricCard label="Receita Push (USD)" value={fmtUSD(totals.total)} icon={Wallet} variant="primary" hint={`${pushRows.length} URL(s) push`} />
        <MetricCard label="Receita Push" value={fmtUSD(totals.push)} icon={Repeat} variant="success" hint={`${byUtm.find((b) => b.utm === "push")?.rows.length ?? 0} URL(s) push`} />
        <MetricCard label="eCPM médio" value={`$${totals.ecpm.toFixed(2)}`} icon={TrendingUp} hint="(receita / impressões) × 1000" />
        <MetricCard label="Não atribuído (agregadas)" value={fmtUSD(totals.unattribTotal)} icon={AlertTriangle} hint={`${unattrib.length} linha(s) isoladas`} />
      </section>

      {byUtm.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Sem dados. Clique em <b>Sincronizar GAM</b> para puxar as URLs e UTMs do período{isAllSites ? " de todos os sites" : ""}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {byUtm.map((bucket) => (
            <UtmGroupCard key={bucket.utm} bucket={bucket} isAllSites={isAllSites} siteName={siteName} />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        ⓘ Linhas agregadas (sem URL exata) são isoladas em <code>unattributed_push_revenue</code> e não contaminam o eCPM nem a tabela por URL.
      </p>

      <PushDebugDialog
        open={debugOpen}
        onOpenChange={setDebugOpen}
        runs={debugRuns}
        syncing={debugging}
        syncState={syncStateQuery.data ?? []}
        siteName={siteName}
      />
    </div>
  );
}

function UtmGroupCard({
  bucket, isAllSites, siteName,
}: {
  bucket: { utm: string; rows: PushRow[]; revenue: number; impressions: number };
  isAllSites: boolean;
  siteName: (id: string) => string;
}) {
  const ecpm = bucket.impressions > 0 ? (bucket.revenue / bucket.impressions) * 1000 : 0;
  const isPush = bucket.utm === "push";
  return (
    <Collapsible defaultOpen={isPush}>
      <Card className={isPush ? "border-primary/40" : undefined}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors py-3">
            <CardTitle className="flex items-center justify-between text-sm gap-3 flex-wrap">
              <span className="flex items-center gap-2">
                <ChevronDown className="h-4 w-4" />
                <Badge variant={isPush ? "default" : "outline"} className="font-mono">utm_source = {bucket.utm}</Badge>
                <span className="text-xs text-muted-foreground">{bucket.rows.length} URL(s)</span>
              </span>
              <div className="flex items-center gap-4 text-xs tabular-nums">
                <span className="text-muted-foreground">imp <b className="text-foreground">{bucket.impressions.toLocaleString("pt-BR")}</b></span>
                <span className="text-muted-foreground">eCPM <b className="text-foreground">${ecpm.toFixed(2)}</b></span>
                <span className="font-semibold text-base">{fmtUSD(bucket.revenue)}</span>
              </div>
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {isAllSites && <TableHead>Site</TableHead>}
                    <TableHead>URL</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead className="text-right">Impressões</TableHead>
                    <TableHead className="text-right">Receita</TableHead>
                    <TableHead className="text-right">eCPM</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bucket.rows.slice(0, 200).map((r) => {
                    const e = r.impressions > 0 ? (Number(r.revenue_usd) / r.impressions) * 1000 : 0;
                    return (
                      <TableRow key={r.id}>
                        {isAllSites && <TableCell className="text-xs">{siteName(r.site_id)}</TableCell>}
                        <TableCell className="max-w-[420px]">
                          <div className="font-mono text-xs truncate" title={r.url}>{r.normalized_url}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.date}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.impressions.toLocaleString("pt-BR")}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{fmtUSD(Number(r.revenue_usd))}</TableCell>
                        <TableCell className="text-right tabular-nums">${e.toFixed(2)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {bucket.rows.length > 200 && (
                <p className="text-xs text-muted-foreground text-center py-2">
                  Mostrando 200 de {bucket.rows.length} URLs (ordenadas por receita).
                </p>
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function PushDebugDialog({
  open, onOpenChange, runs, syncing, syncState, siteName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runs: PushDebugRun[];
  syncing: boolean;
  syncState: any[];
  siteName: (id: string) => string;
}) {
  const total = runs.reduce((acc, r) => {
    const d = r.debug ?? {};
    acc.received += Number(d.rowsReceivedGam ?? d.totalRowsFromGam ?? 0);
    acc.push += Number(d.rowsWithUtmPush ?? d.matchedPush ?? 0);
    acc.inserted += Number(d.rowsInserted ?? r.inserted ?? 0);
    acc.ignored += Number(d.rowsIgnored ?? d.ignoredNoPush ?? 0);
    return acc;
  }, { received: 0, push: 0, inserted: 0, ignored: 0 });

  const latestState = syncState[0] as any | undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[82vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Debug Push</DialogTitle>
          <DialogDescription>
            Auditoria da ingestão GAM → Push por URL, incluindo parser de URL, KEY_VALUES e descartes.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <DebugStat label="Rows GAM" value={total.received} />
          <DebugStat label="utm_source=push" value={total.push} />
          <DebugStat label="Rows gravadas" value={total.inserted} />
          <DebugStat label="Rows ignoradas" value={total.ignored} />
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1">
          <div><b>Última sincronização:</b> {latestState?.last_finished_at ? new Date(latestState.last_finished_at).toLocaleString("pt-BR") : "—"}</div>
          <div><b>Status:</b> {latestState?.last_status ?? "—"}</div>
          <div><b>Último erro:</b> {latestState?.last_error ?? runs.find((r) => !r.ok)?.error ?? "—"}</div>
        </div>

        {syncing && <div className="text-sm text-muted-foreground">Rodando auditoria no GAM…</div>}

        <div className="space-y-3">
          {runs.map((run) => {
            const d = run.debug ?? {};
            return (
              <div key={run.site_id} className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold">{siteName(run.site_id)}</div>
                  <Badge variant={run.ok ? "default" : "destructive"}>{run.ok ? "ok" : "erro"}</Badge>
                </div>
                {run.error ? <div className="text-xs text-danger">{run.error}</div> : (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
                      <DebugStat label="Recebidas" value={Number(d.rowsReceivedGam ?? d.totalRowsFromGam ?? 0)} small />
                      <DebugStat label="Push" value={Number(d.rowsWithUtmPush ?? d.matchedPush ?? 0)} small />
                      <DebugStat label="Gravadas" value={Number(d.rowsInserted ?? run.inserted ?? 0)} small />
                      <DebugStat label="Ignoradas" value={Number(d.rowsIgnored ?? d.ignoredNoPush ?? 0)} small />
                      <DebugStat label="Agregadas" value={Number(d.aggregateRows ?? 0)} small />
                      <DebugStat label="Duplicadas" value={Number(d.duplicates ?? 0)} small />
                    </div>
                    <DebugMap title="Parser encontrou em" data={d.parserSources} />
                    <DebugMap title="Motivos de descarte" data={d.discardReasons} />
                    <div className="grid md:grid-cols-2 gap-3 text-xs">
                      <DebugList title="Amostras gravadas" items={d.sampleMatched ?? []} />
                      <DebugList title="Amostras ignoradas" items={d.sampleIgnored ?? []} />
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Reports testados: {(d.reportModes ?? []).join(", ") || "—"}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DebugStat({ label, value, small }: { label: string; value: number; small?: boolean }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-3", small && "p-2")}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono font-semibold", small ? "text-sm" : "text-xl")}>{value.toLocaleString("pt-BR")}</div>
    </div>
  );
}

function DebugMap({ title, data }: { title: string; data?: Record<string, number> }) {
  const entries = Object.entries(data ?? {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return (
    <div className="text-xs">
      <div className="font-semibold mb-1">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => <Badge key={k} variant="outline" className="font-mono">{k}: {v}</Badge>)}
      </div>
    </div>
  );
}

function DebugList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-md bg-muted/40 p-2 min-h-20">
      <div className="font-semibold mb-1">{title}</div>
      {items.length ? items.map((it, idx) => <div key={idx} className="font-mono text-[11px] break-all">{it}</div>) : <div className="text-muted-foreground">—</div>}
    </div>
  );
}
