import { Fragment, useEffect, useState } from "react";
import { Loader2, Trash2, ShieldAlert, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PreviewCampaign {
  campaign_id: string;
  name: string;
  google_account_id: string;
  cost_brl: number;
  revenue_usd: number;
  matched_utm: boolean;
  roi_pct?: number;
}
interface PreviewItem {
  key?: string;
  placement: string;
  type: string;
  app_id?: string | null;
  cost_brl: number;
  revenue_brl: number;
  revenue_usd: number;
  profit_brl: number;
  roi_pct: number;
  clicks: number;
  impressions: number;
  match_utm: boolean;
  reason: string;
  campaigns: PreviewCampaign[];
}
interface CampaignTotal {
  campaign_id: string; name: string;
  cost_brl: number; revenue_brl: number; profit_brl: number; roi_pct: number;
  bad_count: number;
}
interface PreviewStats {
  eligible: number; total: number; bad?: number; grouped?: number;
  skipped_safety?: number; ads_rows?: number; gam_rows?: number;
  period?: { from: string; to: string };
  grand_cost_brl?: number; grand_revenue_brl?: number; grand_profit_brl?: number;
}
interface PreviewResp { ok?: boolean; error?: string; items?: PreviewItem[]; stats?: PreviewStats; campaign_totals?: CampaignTotal[]; }

export function GlobalPlacementCleanup({ fxUsdBrl }: { fxUsdBrl: number }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [campaignTotals, setCampaignTotals] = useState<CampaignTotal[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<PreviewStats>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDebug, setShowDebug] = useState(true);
  const [minDays, setMinDays] = useState(15);
  const [maxRoi, setMaxRoi] = useState(-10);
  const [minCost, setMinCost] = useState(20);
  const [lookback, setLookback] = useState(15);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const itemKey = (i: PreviewItem) => i.key ?? `${i.campaigns[0]?.campaign_id ?? "global"}|${i.placement}`;
  const canExclude = (i: PreviewItem) => i.type === "WEBSITE" || (i.type === "MOBILE_APPLICATION" && !!i.app_id);

  // carrega config persistida
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("rules_config")
        .select("placement_auto_cleanup_enabled, placement_cleanup_min_days, placement_cleanup_max_roi_pct, placement_cleanup_min_cost_brl, placement_cleanup_last_run_at")
        .maybeSingle();
      if (data) {
        setAutoEnabled(!!data.placement_auto_cleanup_enabled);
        setMinDays(Number(data.placement_cleanup_min_days ?? 20));
        setMaxRoi(Number(data.placement_cleanup_max_roi_pct ?? -10));
        setMinCost(Number(data.placement_cleanup_min_cost_brl ?? 20));
        setLastRun(data.placement_cleanup_last_run_at ?? null);
      }
      const { data: accs } = await supabase
        .from("google_accounts")
        .select("id, account_name, descriptive_name, customer_id")
        .order("account_name", { ascending: true });
      setAccounts((accs ?? []).map((a: any) => ({ id: a.id, name: a.account_name || a.descriptive_name || a.customer_id })));
    })();
  }, []);

  const persistConfig = async (patch: Partial<{
    placement_auto_cleanup_enabled: boolean;
    placement_cleanup_min_days: number;
    placement_cleanup_max_roi_pct: number;
    placement_cleanup_min_cost_brl: number;
  }>) => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase.from("rules_config").update(patch).eq("user_id", u.user.id);
  };

  const toggleAuto = async (on: boolean) => {
    setAutoEnabled(on);
    await persistConfig({
      placement_auto_cleanup_enabled: on,
      placement_cleanup_min_days: minDays,
      placement_cleanup_max_roi_pct: maxRoi,
      placement_cleanup_min_cost_brl: minCost,
    });
    toast({ title: on ? "Limpeza automática ativada (a cada 15 dias)" : "Limpeza automática desativada" });
  };

  const runPreview = async () => {
    setLoading(true);
    setItems([]);
    setSelected(new Set());
    try {
      const { data, error } = await supabase.functions.invoke<PreviewResp>("placements-cleanup", {
        body: {
          mode: "preview",
          min_days: minDays,
          max_roi_pct: maxRoi,
          min_cost_brl: minCost,
          lookback_days: lookback,
          fx_usd_brl: fxUsdBrl,
        },
      });
      if (error || data?.error) {
        toast({ title: "Erro", description: error?.message ?? data?.error, variant: "destructive" });
        return;
      }
      const list = data?.items ?? [];
      setItems(list);
      setCampaignTotals(data?.campaign_totals ?? []);
      setStats(data?.stats);
      setSelected(new Set(list.filter(canExclude).map(itemKey)));
      setExpanded(new Set());
      setOpen(true);
      // persiste filtros
      await persistConfig({
        placement_cleanup_min_days: minDays,
        placement_cleanup_max_roi_pct: maxRoi,
        placement_cleanup_min_cost_brl: minCost,
      });
    } finally {
      setLoading(false);
    }
  };

  const toggle = (k: string) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };
  const toggleAll = (on: boolean) => {
    if (!on) return setSelected(new Set());
    setSelected(new Set(items.filter(canExclude).map(itemKey)));
  };

  const runApply = async () => {
    if (selected.size === 0) { toast({ title: "Nenhum placement selecionado" }); return; }
    if (!confirm(`Aplicar exclusão (negative placement) em ${selected.size} placement(s)?`)) return;
    setApplying(true);
    try {
      const payload = items
        .filter((i) => selected.has(itemKey(i)))
        .map((i) => ({
          key: itemKey(i), placement: i.placement, type: i.type, app_id: i.app_id ?? null,
          cost_brl: i.cost_brl, revenue_brl: i.revenue_brl, revenue_usd: i.revenue_usd, roi_pct: i.roi_pct, reason: i.reason,
          campaigns: i.campaigns.map((c) => ({ campaign_id: c.campaign_id, google_account_id: c.google_account_id, cost_brl: c.cost_brl, revenue_usd: c.revenue_usd, roi_pct: i.roi_pct })),
        }));
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; applied?: number; failed?: number }>(
        "placements-cleanup",
        { body: { mode: "apply", items: payload, fx_usd_brl: fxUsdBrl } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao aplicar", description: error?.message ?? data?.error, variant: "destructive" });
        return;
      }
      toast({
        title: "Limpeza aplicada",
        description: `${data?.applied ?? 0} excluído(s) · ${data?.failed ?? 0} falha(s).`,
      });
      setOpen(false);
    } finally {
      setApplying(false);
    }
  };

  const noMatch = items.filter((i) => !i.match_utm).length;
  const grandCost = stats?.grand_cost_brl ?? 0;
  const grandProfit = stats?.grand_profit_brl ?? 0;

  // filtra items pela conta selecionada
  const filteredItems = accountFilter === "all"
    ? items
    : items.filter((i) => i.campaigns.some((c) => c.google_account_id === accountFilter));

  // agrupa items por campanha
  const itemsByCampaign = new Map<string, PreviewItem[]>();
  for (const it of filteredItems) {
    for (const c of it.campaigns) {
      if (accountFilter !== "all" && c.google_account_id !== accountFilter) continue;
      const arr = itemsByCampaign.get(c.campaign_id) ?? [];
      arr.push(it);
      itemsByCampaign.set(c.campaign_id, arr);
    }
  }
  const sortedCampaigns = [...campaignTotals]
    .filter((c) => (itemsByCampaign.get(c.campaign_id)?.length ?? 0) > 0)
    .sort((a, b) => a.roi_pct - b.roi_pct);

  const toggleExpand = (cid: string) => {
    setExpanded((s) => { const n = new Set(s); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  };
  const toggleCampaignSelection = (cid: string, on: boolean) => {
    const placements = (itemsByCampaign.get(cid) ?? []).filter(canExclude).map(itemKey);
    setSelected((s) => {
      const n = new Set(s);
      for (const p of placements) on ? n.add(p) : n.delete(p);
      return n;
    });
  };

  return (
    <div className="rounded-xl border border-danger/40 bg-danger/5 p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldAlert className="h-5 w-5 text-danger" />
        <div className="flex-1 min-w-[260px]">
          <div className="text-sm font-semibold">Limpeza global de placements</div>
          <div className="text-xs text-muted-foreground">
            Campanhas <b>ENABLED</b> com ≥ <b>{minDays}d</b>. Marca como ruim cada placement com ROI ≤ {maxRoi}% e custo somado ≥ R$ {minCost} nos últimos {lookback} dias. Apps/YouTube ficam de fora da exclusão automática.
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/50">
          <Switch checked={autoEnabled} onCheckedChange={toggleAuto} />
          <div className="text-xs">
            <div className="font-medium">Auto cleanup 15d</div>
            <div className="text-muted-foreground text-[10px]">{lastRun ? `último: ${new Date(lastRun).toLocaleString("pt-BR")}` : "nunca executado"}</div>
          </div>
        </div>
        <Button onClick={runPreview} disabled={loading} variant="destructive">
          {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
          Executar limpeza agora
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Dias mín. <Input type="number" value={minDays} onChange={(e) => setMinDays(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">ROI máx % <Input type="number" value={maxRoi} onChange={(e) => setMaxRoi(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Custo mín BRL <Input type="number" value={minCost} onChange={(e) => setMinCost(+e.target.value)} className="h-6 w-20 text-xs" /></label>
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">Período: <Badge variant="outline" className="text-[10px]">Últimos 15 dias</Badge></span>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-7xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Preview · placements ruins</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Período: {stats?.period?.from} → {stats?.period?.to}</Badge>
              <Badge variant="outline">{stats?.eligible}/{stats?.total} campanhas</Badge>
              <Badge variant="outline">{stats?.grouped} placements analisados</Badge>
              <Badge variant="destructive">{items.length} ruins</Badge>
              {noMatch > 0 && <Badge variant="outline" className="border-warning text-warning">{noMatch} sem UTM</Badge>}
              <Badge variant="secondary">Custo (15d): {fmtBRL(grandCost)} · Lucro: {fmtBRL(grandProfit)}</Badge>
              <span className="ml-auto flex items-center gap-2 text-xs">
                Debug <Switch checked={showDebug} onCheckedChange={setShowDebug} />
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-auto flex-1 border border-border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-10"></TableHead>
                  <TableHead>Campanha</TableHead>
                  <TableHead className="text-right">Custo (15d)</TableHead>
                  <TableHead className="text-right">Receita (15d)</TableHead>
                  <TableHead className="text-right">Lucro</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Ruins</TableHead>
                  <TableHead className="text-right">Selec.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedCampaigns.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Nada a limpar 🎉</TableCell></TableRow>
                )}
                {sortedCampaigns.map((camp) => {
                  const list = itemsByCampaign.get(camp.campaign_id) ?? [];
                  const websiteList = list.filter((i) => i.type === "WEBSITE");
                  const allSelected = websiteList.length > 0 && websiteList.every((i) => selected.has(itemKey(i)));
                  const isOpen = expanded.has(camp.campaign_id);
                  return (
                    <Fragment key={camp.campaign_id}>
                      <TableRow key={camp.campaign_id} className="cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand(camp.campaign_id)}>
                        <TableCell><span className="text-xs">{isOpen ? "▼" : "▶"}</span></TableCell>
                        <TableCell className="font-medium text-sm">{camp.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtBRL(camp.cost_brl)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtBRL(camp.revenue_brl)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", camp.profit_brl < 0 && "text-danger")}>{fmtBRL(camp.profit_brl)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums font-semibold", camp.roi_pct < 0 ? "text-danger" : "text-success")}>{fmtPercent(camp.roi_pct)}</TableCell>
                        <TableCell className="text-right"><Badge variant="destructive">{list.length}</Badge></TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={allSelected} onCheckedChange={(v) => toggleCampaignSelection(camp.campaign_id, !!v)} />
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${camp.campaign_id}-detail`}>
                          <TableCell colSpan={8} className="bg-muted/10 p-0">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="w-10"></TableHead>
                                  <TableHead>Placement</TableHead>
                                  <TableHead>Tipo</TableHead>
                                  <TableHead className="text-right">Cliques</TableHead>
                                  <TableHead className="text-right">Custo</TableHead>
                                  <TableHead className="text-right">Receita</TableHead>
                                  <TableHead className="text-right">ROI</TableHead>
                                  {showDebug && <TableHead>Match</TableHead>}
                                  {showDebug && <TableHead>Motivo</TableHead>}
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {list.map((i) => {
                                  const isApp = i.type !== "WEBSITE";
                                  const c = i.campaigns.find((x) => x.campaign_id === camp.campaign_id);
                                  return (
                                    <TableRow key={itemKey(i)} className={cn(isApp && "opacity-60")}>
                                      <TableCell>
                                        <Checkbox checked={selected.has(itemKey(i))} disabled={isApp} onCheckedChange={() => toggle(itemKey(i))} />
                                      </TableCell>
                                      <TableCell className="font-mono text-xs max-w-[300px] truncate" title={i.placement}>{i.placement}</TableCell>
                                      <TableCell className="text-xs">{i.type}{isApp && <Badge variant="secondary" className="ml-1 text-[9px]">manual</Badge>}</TableCell>
                                      <TableCell className="text-right tabular-nums text-xs">{fmtNumber(i.clicks)}</TableCell>
                                      <TableCell className="text-right tabular-nums text-xs">{fmtBRL(c?.cost_brl ?? 0)}</TableCell>
                                      <TableCell className="text-right tabular-nums text-xs">${(c?.revenue_usd ?? 0).toFixed(2)}</TableCell>
                                      <TableCell className="text-right tabular-nums text-xs text-danger font-semibold">{fmtPercent(i.roi_pct)}</TableCell>
                                      {showDebug && (
                                        <TableCell>
                                          {c?.matched_utm
                                            ? <Badge variant="outline" className="text-[9px]">true</Badge>
                                            : <Badge variant="outline" className="text-[9px] border-warning text-warning">false</Badge>}
                                        </TableCell>
                                      )}
                                      {showDebug && <TableCell className="text-[10px] font-mono">{i.reason}</TableCell>}
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
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="destructive" disabled={applying || selected.size === 0} onClick={runApply}>
              {applying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Aplicar exclusão ({selected.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
