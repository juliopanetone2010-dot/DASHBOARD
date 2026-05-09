import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { RefreshCw, Repeat, Sparkles, Wallet, TrendingUp, CalendarIcon, Zap } from "lucide-react";
import { fmtUSD, fmtCurrency } from "@/lib/format";
import { supabase } from "@/integrations/supabase/client";
import type { Campaign } from "@/types/domain";
import { MetricCard } from "./MetricCard";
import { REV_SHARE_PCT } from "@/engine/rules";
import { useDashboardFilters } from "@/contexts/FilterContext";
import { DATE_PRESETS, presetFromRange, type DatePresetKey } from "@/components/dashboard/FilterBar";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface SourceRow {
  id: string;
  campaign_id: string;
  date: string;
  utm_source: string;
  revenue_usd: number;
  impressions: number;
}

interface Props {
  campaigns: Campaign[];
}

export function RetentionTab({ campaigns }: Props) {
  const { range: globalRange, filters } = useDashboardFilters();
  const queryClient = useQueryClient();

  // Override local de período (independente do dashboard)
  const [localRange, setLocalRange] = useState<{ from: string; to: string } | null>(null);
  const range = localRange ?? globalRange;
  const activePreset: DatePresetKey | null = presetFromRange(range.from, range.to);

  const applyPreset = (key: DatePresetKey) => {
    const p = DATE_PRESETS.find((x) => x.key === key);
    if (p) setLocalRange(p.range());
  };

  const queryKey = useMemo(
    () => ["retention", range.from, range.to, filters.siteId, filters.googleAccountIds.join("|")],
    [range.from, range.to, filters.siteId, filters.googleAccountIds],
  );

  const rowsQuery = useQuery<SourceRow[]>({
    queryKey,
    queryFn: async () => {
      if (import.meta.env.DEV) console.info("[retention] fetch", queryKey);
      let q = supabase
        .from("gam_campaign_source_revenue")
        .select("id, campaign_id, date, utm_source, revenue_usd, impressions")
        .gte("date", range.from)
        .lte("date", range.to);
      if (filters.siteId !== "all") q = q.eq("site_id", filters.siteId);
      const { data } = await q.order("date", { ascending: false }).limit(5000);
      return (data ?? []) as SourceRow[];
    },
    staleTime: 30_000,
  });

  const fxQuery = useQuery<number>({
    queryKey: ["fx-usd-brl"],
    queryFn: async () => {
      const r = await fetch("https://open.er-api.com/v6/latest/USD");
      const j = await r.json();
      const rate = Number(j?.rates?.BRL);
      return Number.isFinite(rate) && rate > 0 ? rate : 5;
    },
    staleTime: 60 * 60 * 1000,
  });

  const rows = rowsQuery.data ?? [];
  const usdBrl = fxQuery.data ?? 5;
  const loading = rowsQuery.isFetching;

  const load = async () => {
    if (filters.siteId !== "all") {
      await supabase.functions.invoke("site-auto-onboard", { body: { site_id: filters.siteId, force: true } });
    }
    await queryClient.invalidateQueries({ queryKey });
  };

  const campaignName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of campaigns) m.set(c.campaign_id, c.name);
    return m;
  }, [campaigns]);

  // Agrega por (campaign_id, source)
  const byCampaign = useMemo(() => {
    const map = new Map<string, {
      campaign_id: string;
      google: number; push: number; other: number; total: number;
      googleImpr: number; pushImpr: number; otherImpr: number;
    }>();
    for (const r of rows) {
      const cur = map.get(r.campaign_id) ?? {
        campaign_id: r.campaign_id, google: 0, push: 0, other: 0, total: 0,
        googleImpr: 0, pushImpr: 0, otherImpr: 0,
      };
      const usd = Number(r.revenue_usd) || 0;
      const impr = Number(r.impressions) || 0;
      cur.total += usd;
      if (r.utm_source === "google") { cur.google += usd; cur.googleImpr += impr; }
      else if (r.utm_source === "push") { cur.push += usd; cur.pushImpr += impr; }
      else { cur.other += usd; cur.otherImpr += impr; }
      map.set(r.campaign_id, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [rows]);

  const totals = useMemo(() => {
    return byCampaign.reduce((acc, c) => ({
      google: acc.google + c.google,
      push: acc.push + c.push,
      other: acc.other + c.other,
      total: acc.total + c.total,
    }), { google: 0, push: 0, other: 0, total: 0 });
  }, [byCampaign]);

  const net = (usd: number) => usd * (1 - REV_SHARE_PCT) * usdBrl;

  const fromDate = range.from ? new Date(range.from + "T00:00:00") : undefined;
  const toDate = range.to ? new Date(range.to + "T00:00:00") : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Retenção / Push</h2>
          <p className="text-xs text-muted-foreground">
            Receita de usuários retidos via push (sem custo adicional). Comparado ao tráfego pago do Google Ads.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Período: {range.from} → {range.to}
          </Badge>
          {localRange && (
            <Button size="sm" variant="ghost" onClick={() => setLocalRange(null)} className="h-8 text-xs">
              Usar período do dashboard
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Atualizar
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-3 shadow-elegant">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground pr-1">
            <Zap className="h-3.5 w-3.5" /> Período
          </div>
          {DATE_PRESETS.map((p) => (
            <Button
              key={p.key}
              type="button"
              size="sm"
              variant={activePreset === p.key ? "default" : "outline"}
              onClick={() => applyPreset(p.key)}
              className="h-8"
            >
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
              <Calendar
                mode="single"
                selected={fromDate}
                onSelect={(d) => d && setLocalRange({ from: format(d, "yyyy-MM-dd"), to: range.to })}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
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
              <Calendar
                mode="single"
                selected={toDate}
                onSelect={(d) => d && setLocalRange({ from: range.from, to: format(d, "yyyy-MM-dd") })}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Aquisição (Google)"
          value={fmtUSD(totals.google)}
          icon={Wallet}
          hint={`${fmtCurrency(net(totals.google))} líquido (BRL)`}
        />
        <MetricCard
          label="Retenção (Push)"
          value={fmtUSD(totals.push)}
          icon={Repeat}
          variant="primary"
          hint="Sem custo adicional"
        />
        <MetricCard
          label="Outras origens"
          value={fmtUSD(totals.other)}
          icon={Sparkles}
          hint="Orgânico / direto / desconhecido"
        />
        <MetricCard
          label="LTV total (USD)"
          value={fmtUSD(totals.total)}
          icon={TrendingUp}
          variant="success"
          hint={`google + push + outras = ${fmtCurrency(net(totals.total))} líquido`}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>LTV por campanha ({range.from} → {range.to})</span>
            <Badge variant="outline">{byCampaign.length} campanha(s)</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {byCampaign.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Sem receita atribuída por UTM ainda. Aplique as UTMs nas campanhas e aguarde o tráfego retornar.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campanha</TableHead>
                    <TableHead className="text-right">Google (USD)</TableHead>
                    <TableHead className="text-right">Push (USD)</TableHead>
                    <TableHead className="text-right">Outras</TableHead>
                    <TableHead className="text-right">LTV total</TableHead>
                    <TableHead className="text-right">% Retenção</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byCampaign.map((c) => {
                    const pctPush = c.total > 0 ? (c.push / c.total) * 100 : 0;
                    return (
                      <TableRow key={c.campaign_id}>
                        <TableCell>
                          <div className="font-medium text-sm">
                            {campaignName.get(c.campaign_id) ?? `#${c.campaign_id}`}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono">{c.campaign_id}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtUSD(c.google)}</TableCell>
                        <TableCell className="text-right tabular-nums text-primary">{fmtUSD(c.push)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtUSD(c.other)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{fmtUSD(c.total)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={pctPush > 30 ? "default" : "outline"}>
                            {pctPush.toFixed(1)}%
                          </Badge>
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

      <p className="text-xs text-muted-foreground">
        ⓘ ROI/ROAS na aba Dashboard considera <b>somente</b> receita com <code>utm_source=google</code>.
        Receita de push é retenção (sem custo adicional) e entra apenas no LTV acima.
      </p>
    </div>
  );
}
