import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, Globe, Play, ShieldAlert, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

interface GeoItem {
  campaign_id: string;
  campaign_name: string;
  google_account_id: string | null;
  country_code: string;
  country_name: string;
  country_criterion_id: string | null;
  cost_brl: number;
  revenue_brl: number;
  profit_brl: number;
  roi_pct: number;
  campaign_cost_brl: number;
  countries_in_campaign: number;
  status: "ok" | "monitor" | "remove";
  reason: string;
  protected: boolean;
}
interface GeoStats {
  total_cells?: number; campaigns?: number;
  to_remove?: number; monitor?: number; ok?: number;
  period?: { from: string; to: string };
}

export function GeoCleanupPanel({ fxUsdBrl, siteId }: { fxUsdBrl: number; siteId: string | null }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [items, setItems] = useState<GeoItem[]>([]);
  const [stats, setStats] = useState<GeoStats>();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [autoEnabled, setAutoEnabled] = useState(false);
  const [maxRoi, setMaxRoi] = useState(-10);
  const [minCost, setMinCost] = useState(50);
  const [minCountries, setMinCountries] = useState(3);
  const [minCampCost, setMinCampCost] = useState(400);
  const [lookback, setLookback] = useState(15);
  const [recentChangeDays, setRecentChangeDays] = useState(7);
  const [minCampAgeDays, setMinCampAgeDays] = useState(10);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const itemKey = (i: GeoItem) => `${i.campaign_id}|${i.country_code}`;

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("rules_config")
        .select("geo_auto_cleanup_enabled, geo_cleanup_max_roi_pct, geo_cleanup_min_cost_brl, geo_cleanup_min_countries, geo_cleanup_min_campaign_cost_brl, geo_cleanup_lookback_days, geo_cleanup_last_run_at")
        .maybeSingle();
      if (data) {
        setAutoEnabled(!!data.geo_auto_cleanup_enabled);
        setMaxRoi(Number(data.geo_cleanup_max_roi_pct ?? -10));
        setMinCost(Number(data.geo_cleanup_min_cost_brl ?? 50));
        setMinCountries(Number(data.geo_cleanup_min_countries ?? 3));
        setMinCampCost(Number(data.geo_cleanup_min_campaign_cost_brl ?? 500));
        setLookback(Number(data.geo_cleanup_lookback_days ?? 15));
        setLastRun(data.geo_cleanup_last_run_at ?? null);
      }
    })();
  }, []);

  const persist = async (patch: Record<string, unknown>) => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase.from("rules_config").update(patch as never).eq("user_id", u.user.id);
  };

  const toggleAuto = async (on: boolean) => {
    setAutoEnabled(on);
    await persist({
      geo_auto_cleanup_enabled: on,
      geo_cleanup_max_roi_pct: maxRoi,
      geo_cleanup_min_cost_brl: minCost,
      geo_cleanup_min_countries: minCountries,
      geo_cleanup_min_campaign_cost_brl: minCampCost,
      geo_cleanup_lookback_days: lookback,
    });
    toast({ title: on ? "Limpeza automática de países ativada (a cada 15 dias)" : "Limpeza automática de países desativada" });
  };

  const runPreview = async () => {
    if (!siteId || siteId === "all") {
      toast({ title: "Selecione um site", description: "A limpeza de países precisa de um site para evitar afetar outros.", variant: "destructive" });
      return;
    }
    setLoading(true);
    setItems([]);
    setSelected(new Set());
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; items?: GeoItem[]; stats?: GeoStats }>(
        "geo-cleanup",
        {
          body: {
            mode: "preview",
            site_id: siteId,
            max_roi_pct: maxRoi,
            min_cost_brl: minCost,
            min_countries: minCountries,
            min_campaign_cost_brl: minCampCost,
            lookback_days: lookback,
            recent_change_days: recentChangeDays,
            min_campaign_age_days: minCampAgeDays,
            fx_usd_brl: fxUsdBrl,
          },
        },
      );
      if (error || data?.error) {
        toast({ title: "Erro", description: error?.message ?? data?.error, variant: "destructive" });
        return;
      }
      const list = data?.items ?? [];
      setItems(list);
      setStats(data?.stats);
      setSelected(new Set(list.filter((i) => i.status === "remove" && i.country_criterion_id).map(itemKey)));
      setOpen(true);
      await persist({
        geo_cleanup_max_roi_pct: maxRoi,
        geo_cleanup_min_cost_brl: minCost,
        geo_cleanup_min_countries: minCountries,
        geo_cleanup_min_campaign_cost_brl: minCampCost,
        geo_cleanup_lookback_days: lookback,
      });
    } finally { setLoading(false); }
  };

  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const runApply = async () => {
    const payload = items
      .filter((i) => selected.has(itemKey(i)) && i.country_criterion_id)
      .map((i) => ({
        campaign_id: i.campaign_id,
        google_account_id: i.google_account_id,
        country_code: i.country_code,
        country_name: i.country_name,
        country_criterion_id: i.country_criterion_id!,
        cost_brl: i.cost_brl,
        revenue_brl: i.revenue_brl,
        roi_pct: i.roi_pct,
      }));
    if (payload.length === 0) { toast({ title: "Nenhum país selecionado" }); return; }
    if (!confirm(`Remover ${payload.length} país(es) das campanhas?`)) return;

    setApplying(true);
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; applied?: number; failed?: number }>(
        "geo-cleanup",
        { body: { mode: "apply", site_id: siteId, items: payload, fx_usd_brl: fxUsdBrl } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao aplicar", description: error?.message ?? data?.error, variant: "destructive" });
        return;
      }
      toast({ title: "Limpeza aplicada", description: `${data?.applied ?? 0} removido(s) · ${data?.failed ?? 0} falha(s).` });
      setOpen(false);
    } finally { setApplying(false); }
  };

  const removeOnly = items.filter((i) => i.status === "remove");
  const monitorOnly = items.filter((i) => i.status === "monitor");

  // Agrupa por campanha
  const grouped = useMemo(() => {
    const map = new Map<string, { campaign_id: string; campaign_name: string; countries_in_campaign: number; campaign_cost_brl: number; rows: GeoItem[]; toRemove: number }>();
    for (const i of items) {
      const g = map.get(i.campaign_id) ?? {
        campaign_id: i.campaign_id,
        campaign_name: i.campaign_name,
        countries_in_campaign: i.countries_in_campaign,
        campaign_cost_brl: i.campaign_cost_brl,
        rows: [],
        toRemove: 0,
      };
      g.rows.push(i);
      if (i.status === "remove") g.toRemove++;
      map.set(i.campaign_id, g);
    }
    return [...map.values()].sort((a, b) => b.toRemove - a.toRemove || b.campaign_cost_brl - a.campaign_cost_brl);
  }, [items]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (cid: string) => setExpanded((s) => { const n = new Set(s); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Globe className="h-5 w-5 text-warning" />
        <div className="flex-1 min-w-[260px]">
          <div className="text-sm font-semibold">Limpeza de países</div>
          <div className="text-xs text-muted-foreground">
            Marca como remover países com ROI ≤ {maxRoi}% e custo ≥ R$ {minCost} dentro de campanhas com ≥ {minCountries} países, gasto ≥ R$ {minCampCost} e rodando há ≥ {minCampAgeDays}d (últimos {lookback}d).
            Campanhas em <b>testing</b> ou alteradas nos últimos <b>{recentChangeDays}d</b> são ignoradas.
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/50">
          <Switch checked={autoEnabled} onCheckedChange={toggleAuto} />
          <div className="text-xs">
            <div className="font-medium">Auto cleanup 15d</div>
            <div className="text-muted-foreground text-[10px]">{lastRun ? `último: ${new Date(lastRun).toLocaleString("pt-BR")}` : "nunca executado"}</div>
          </div>
        </div>
        <Button onClick={runPreview} disabled={loading} variant="default">
          {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
          Analisar países agora
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">ROI máx % <Input type="number" value={maxRoi} onChange={(e) => setMaxRoi(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Custo mín país BRL <Input type="number" value={minCost} onChange={(e) => setMinCost(+e.target.value)} className="h-6 w-20 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Mín. países/camp. <Input type="number" value={minCountries} onChange={(e) => setMinCountries(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Custo mín camp. BRL <Input type="number" value={minCampCost} onChange={(e) => setMinCampCost(+e.target.value)} className="h-6 w-20 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Janela (d) <Input type="number" value={lookback} onChange={(e) => setLookback(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Idade mín camp. (d) <Input type="number" value={minCampAgeDays} onChange={(e) => setMinCampAgeDays(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Ignorar se alterada (d) <Input type="number" value={recentChangeDays} onChange={(e) => setRecentChangeDays(+e.target.value)} className="h-6 w-16 text-xs" /></label>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-7xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Preview · países por campanha</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Período: {stats?.period?.from} → {stats?.period?.to}</Badge>
              <Badge variant="outline">{grouped.length} campanhas</Badge>
              <Badge variant="destructive">🔴 {removeOnly.length} remover</Badge>
              <Badge variant="outline" className="border-warning text-warning">🟡 {monitorOnly.length} monitorar</Badge>
              <Badge variant="outline" className="border-success text-success">🟢 {stats?.ok ?? 0} ok</Badge>
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-auto flex-1 border border-border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-10"></TableHead>
                  <TableHead className="w-10"></TableHead>
                  <TableHead>Campanha</TableHead>
                  <TableHead className="text-right">Países</TableHead>
                  <TableHead className="text-right">Custo camp.</TableHead>
                  <TableHead className="text-right">A remover</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grouped.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Nada a limpar 🎉</TableCell></TableRow>
                )}
                {grouped.map((g) => {
                  const isOpen = expanded.has(g.campaign_id);
                  const removable = g.rows.filter((r) => r.status === "remove" && r.country_criterion_id);
                  const allSelected = removable.length > 0 && removable.every((r) => selected.has(itemKey(r)));
                  const toggleAllCamp = () => {
                    setSelected((s) => {
                      const n = new Set(s);
                      if (allSelected) removable.forEach((r) => n.delete(itemKey(r)));
                      else removable.forEach((r) => n.add(itemKey(r)));
                      return n;
                    });
                  };
                  return (
                    <Fragment key={g.campaign_id}>
                      <TableRow className="bg-muted/20 hover:bg-muted/30 cursor-pointer" onClick={() => toggleExpand(g.campaign_id)}>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {removable.length > 0 && (
                            <Checkbox checked={allSelected} onCheckedChange={toggleAllCamp} />
                          )}
                        </TableCell>
                        <TableCell><Eye className={cn("h-4 w-4 transition-transform", isOpen && "rotate-90")} /></TableCell>
                        <TableCell className="font-medium text-sm">{g.campaign_name}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{g.countries_in_campaign}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{fmtBRL(g.campaign_cost_brl)}</TableCell>
                        <TableCell className="text-right">
                          {g.toRemove > 0 ? <Badge variant="destructive">{g.toRemove}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-background p-0">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="w-10"></TableHead>
                                  <TableHead>Status</TableHead>
                                  <TableHead>País</TableHead>
                                  <TableHead className="text-right">Custo</TableHead>
                                  <TableHead className="text-right">Receita</TableHead>
                                  <TableHead className="text-right">ROI</TableHead>
                                  <TableHead>Motivo</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {g.rows
                                  .slice()
                                  .sort((a, b) => {
                                    const order = { remove: 0, monitor: 1, ok: 2 } as const;
                                    return order[a.status] - order[b.status] || a.roi_pct - b.roi_pct;
                                  })
                                  .map((i) => {
                                    const k = itemKey(i);
                                    const canSelect = i.status === "remove" && !!i.country_criterion_id;
                                    return (
                                      <TableRow key={k} className={cn(i.status === "remove" && "bg-danger/5")}>
                                        <TableCell>{canSelect ? <Checkbox checked={selected.has(k)} onCheckedChange={() => toggle(k)} /> : null}</TableCell>
                                        <TableCell>
                                          {i.status === "remove" && <Badge variant="destructive">🔴 Remover</Badge>}
                                          {i.status === "monitor" && <Badge variant="outline" className="border-warning text-warning">🟡 Monitorar</Badge>}
                                          {i.status === "ok" && <Badge variant="outline" className="border-success text-success">🟢 OK</Badge>}
                                        </TableCell>
                                        <TableCell className="text-sm">
                                          <span className="font-mono text-xs text-muted-foreground mr-1">{i.country_code}</span>
                                          {i.country_name}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">{fmtBRL(i.cost_brl)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{fmtBRL(i.revenue_brl)}</TableCell>
                                        <TableCell className={cn("text-right tabular-nums font-semibold", i.roi_pct < 0 ? "text-danger" : "text-success")}>{fmtPercent(i.roi_pct)}</TableCell>
                                        <TableCell className="text-xs text-muted-foreground">{i.reason}</TableCell>
                                      </TableRow>
                                    );
                                  })}
                              </TableBody>
                            </Table>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <DialogFooter className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground mr-auto flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5" />
              {selected.size} selecionado(s) para remoção
            </div>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="destructive" onClick={runApply} disabled={applying || selected.size === 0}>
              {applying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Aplicar limpeza ({selected.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
