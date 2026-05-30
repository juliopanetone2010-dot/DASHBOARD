import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RefreshCw, Repeat, Wallet, TrendingUp, CalendarIcon, Zap, AlertTriangle, ChevronDown, Globe } from "lucide-react";
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

interface Props {
  campaigns: Campaign[];
}

export function RetentionTab(_props: Props) {
  const { range: globalRange, filters } = useDashboardFilters();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
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

  const rows = rowsQuery.data ?? [];
  const unattrib = unattribQuery.data ?? [];
  const loading = rowsQuery.isFetching || syncing;
  const siteName = (id: string) => sitesQuery.data?.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  // Agrupa por utm_source
  const byUtm = useMemo(() => {
    const map = new Map<string, { utm: string; rows: PushRow[]; revenue: number; impressions: number }>();
    for (const r of rows) {
      const utm = (r.utm_source || "(none)").toLowerCase();
      const cur = map.get(utm) ?? { utm, rows: [], revenue: 0, impressions: 0 };
      cur.rows.push(r);
      cur.revenue += Number(r.revenue_usd || 0);
      cur.impressions += Number(r.impressions || 0);
      map.set(utm, cur);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [rows]);

  const totals = useMemo(() => {
    const total = rows.reduce((s, r) => s + Number(r.revenue_usd || 0), 0);
    const impressions = rows.reduce((s, r) => s + Number(r.impressions || 0), 0);
    const pushBucket = byUtm.find((b) => b.utm === "push");
    const unattribTotal = unattrib.reduce((s, r) => s + Number(r.revenue_usd || 0), 0);
    const ecpm = impressions > 0 ? (total / impressions) * 1000 : 0;
    return { total, impressions, push: pushBucket?.revenue ?? 0, unattribTotal, ecpm };
  }, [rows, unattrib, byUtm]);

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
      toast({
        title: "Sincronização concluída",
        description: `${targets.length} site(s) • ${inserted} URLs • ${unattributed} agregadas${errs ? ` • ${errs} erro(s)` : ""}`,
      });
    } finally {
      setSyncing(false);
      setProgress(null);
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
            Receita do GAM agrupada por <code>utm_source</code> e URL exata. Inclui push, email, organic e outros.
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
        <MetricCard label="Receita Total (USD)" value={fmtUSD(totals.total)} icon={Wallet} variant="primary" hint={`${rows.length} URL(s) • ${byUtm.length} utm(s)`} />
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
