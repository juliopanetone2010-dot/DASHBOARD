import { useState } from "react";
import { Loader2, Trash2, ShieldAlert } from "lucide-react";
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
  matched_utm: boolean;
}
interface PreviewItem {
  placement: string;
  type: string;
  cost_brl: number;
  revenue_brl: number;
  profit_brl: number;
  roi_pct: number;
  clicks: number;
  impressions: number;
  campaigns: PreviewCampaign[];
}
interface PreviewResp {
  ok?: boolean;
  error?: string;
  items?: PreviewItem[];
  stats?: { eligible: number; total: number; bad?: number; period?: { from: string; to: string } };
}

export function GlobalPlacementCleanup({ fxUsdBrl }: { fxUsdBrl: number }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [stats, setStats] = useState<PreviewResp["stats"]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDebug, setShowDebug] = useState(false);
  const [minDays, setMinDays] = useState(20);
  const [maxRoi, setMaxRoi] = useState(-10);
  const [minCost, setMinCost] = useState(50);
  const [minClicks, setMinClicks] = useState(100);
  const [lookback, setLookback] = useState(30);

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
          min_clicks: minClicks,
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
      setStats(data?.stats);
      // por padrão seleciona apenas WEBSITE (apps/youtube precisam aprovação manual)
      setSelected(new Set(list.filter((i) => i.type === "WEBSITE").map((i) => i.placement)));
      setOpen(true);
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
    setSelected(new Set(items.filter((i) => i.type === "WEBSITE").map((i) => i.placement)));
  };

  const runApply = async () => {
    if (selected.size === 0) { toast({ title: "Nenhum placement selecionado" }); return; }
    if (!confirm(`Aplicar exclusão (negative placement) em ${selected.size} placement(s) nas campanhas afetadas?`)) return;
    setApplying(true);
    try {
      const payload = items
        .filter((i) => selected.has(i.placement))
        .map((i) => ({
          placement: i.placement, type: i.type,
          campaigns: i.campaigns.map((c) => ({ campaign_id: c.campaign_id, google_account_id: c.google_account_id })),
        }));
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; applied?: number; failed?: number; details?: unknown }>(
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

  const totalCost = items.reduce((a, i) => a + i.cost_brl, 0);
  const totalLoss = items.reduce((a, i) => a + i.profit_brl, 0);

  return (
    <div className="rounded-xl border border-danger/40 bg-danger/5 p-4 flex flex-wrap items-center gap-3">
      <ShieldAlert className="h-5 w-5 text-danger" />
      <div className="flex-1 min-w-[260px]">
        <div className="text-sm font-semibold">Limpeza global de placements</div>
        <div className="text-xs text-muted-foreground">
          Analisa todas as campanhas <b>ENABLED</b> com pelo menos <b>{minDays} dias</b> rodando, agrupa placements e marca os com ROI ≤ {maxRoi}% (custo ≥ R$ {minCost} <i>ou</i> {minClicks} cliques). Apps e YouTube ficam de fora da exclusão automática.
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <label className="text-[11px] text-muted-foreground flex items-center gap-1">Dias mín. <Input type="number" value={minDays} onChange={(e) => setMinDays(+e.target.value)} className="h-6 w-16 text-xs" /></label>
          <label className="text-[11px] text-muted-foreground flex items-center gap-1">ROI máx % <Input type="number" value={maxRoi} onChange={(e) => setMaxRoi(+e.target.value)} className="h-6 w-16 text-xs" /></label>
          <label className="text-[11px] text-muted-foreground flex items-center gap-1">Custo mín BRL <Input type="number" value={minCost} onChange={(e) => setMinCost(+e.target.value)} className="h-6 w-20 text-xs" /></label>
          <label className="text-[11px] text-muted-foreground flex items-center gap-1">Cliques mín <Input type="number" value={minClicks} onChange={(e) => setMinClicks(+e.target.value)} className="h-6 w-20 text-xs" /></label>
          <label className="text-[11px] text-muted-foreground flex items-center gap-1">Período (d) <Input type="number" value={lookback} onChange={(e) => setLookback(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        </div>
      </div>
      <Button onClick={runPreview} disabled={loading} variant="destructive">
        {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
        Limpar placements ruins (global)
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-6xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Preview · placements ruins</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Período: {stats?.period?.from} → {stats?.period?.to}</Badge>
              <Badge variant="outline">{stats?.eligible}/{stats?.total} campanhas elegíveis</Badge>
              <Badge variant="destructive">{items.length} placements ruins</Badge>
              <Badge variant="secondary">Custo total: {fmtBRL(totalCost)} · Prejuízo: {fmtBRL(totalLoss)}</Badge>
              <span className="ml-auto flex items-center gap-2 text-xs">
                Debug <Switch checked={showDebug} onCheckedChange={setShowDebug} />
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-auto flex-1 border border-border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-10">
                    <Checkbox
                      checked={selected.size > 0 && selected.size === items.filter((i) => i.type === "WEBSITE").length}
                      onCheckedChange={(v) => toggleAll(!!v)}
                    />
                  </TableHead>
                  <TableHead>Placement</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead className="text-right">Cliques</TableHead>
                  <TableHead className="text-right">Custo</TableHead>
                  <TableHead className="text-right">Receita</TableHead>
                  <TableHead className="text-right">Lucro</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Campanhas</TableHead>
                  {showDebug && <TableHead>Match UTM</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 && (
                  <TableRow><TableCell colSpan={showDebug ? 10 : 9} className="text-center py-8 text-muted-foreground">Nada a limpar 🎉</TableCell></TableRow>
                )}
                {items.map((i) => {
                  const isApp = i.type !== "WEBSITE";
                  return (
                    <TableRow key={i.placement} className={cn(isApp && "opacity-60")}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(i.placement)}
                          disabled={isApp}
                          onCheckedChange={() => toggle(i.placement)}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs max-w-[260px] truncate" title={i.placement}>{i.placement}</TableCell>
                      <TableCell className="text-xs">
                        {i.type}{isApp && <Badge variant="secondary" className="ml-1 text-[9px]">manual</Badge>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNumber(i.clicks)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(i.cost_brl)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(i.revenue_brl)}</TableCell>
                      <TableCell className="text-right tabular-nums text-danger">{fmtBRL(i.profit_brl)}</TableCell>
                      <TableCell className="text-right tabular-nums text-danger font-semibold">{fmtPercent(i.roi_pct)}</TableCell>
                      <TableCell className="text-right text-xs">
                        <details>
                          <summary className="cursor-pointer">{i.campaigns.length}</summary>
                          <ul className="text-left mt-1 space-y-0.5">
                            {i.campaigns.map((c) => (
                              <li key={c.campaign_id} className="text-[10px]">
                                {c.name} <span className="text-muted-foreground">({fmtBRL(c.cost_brl)})</span>
                                {!c.matched_utm && <span className="text-warning"> · sem UTM</span>}
                              </li>
                            ))}
                          </ul>
                        </details>
                      </TableCell>
                      {showDebug && (
                        <TableCell className="text-[10px] font-mono">
                          {i.campaigns.filter((c) => c.matched_utm).length}/{i.campaigns.length}
                        </TableCell>
                      )}
                    </TableRow>
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
