import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw, AlertTriangle, CheckCircle2, XCircle, Activity } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { fmtCurrency, fmtPercent, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  campaignId: string;
  campaignName?: string;
  googleAccountId?: string | null;
  onChanged?: () => void;
}

type DailyRow = {
  date: string;
  cost: number;
  revenue: number;
  profit: number;
  roi: number;
  conversions: number;
  clicks: number;
  impressions: number;
  ecpm: number;
};

type PreviewResp = {
  daily: DailyRow[];
  days: number;
  totals: { cost: number; revenue: number; conversions: number; impressions: number; roi: number; ecpm: number; cpa: number };
  campaign: { current_budget_brl: number | null; current_cpa_brl: number | null; applied_cpa_brl: number | null };
  active_flow: { id: string; stage: string; status: string; start_date: string } | null;
};

const DAY_PRESETS = [7, 15, 30];

export function RestartCampaignButton({ campaignId, campaignName, googleAccountId, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(7);
  const [budgetBrl, setBudgetBrl] = useState<number>(40);
  const qc = useQueryClient();

  const previewQ = useQuery({
    queryKey: ["restart-preview", campaignId, googleAccountId ?? null, days],
    enabled: open,
    queryFn: async (): Promise<PreviewResp> => {
      const { data, error } = await supabase.functions.invoke<PreviewResp>("campaign-restart", {
        body: { action: "preview", campaign_id: campaignId, google_account_id: googleAccountId ?? null, days },
      });
      if (error) throw error;
      return data!;
    },
  });

  const initMut = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>("campaign-restart", {
        body: { action: "init", campaign_id: campaignId, google_account_id: googleAccountId ?? null, budget_brl: budgetBrl },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Reinício iniciado", description: `R$ ${budgetBrl}/dia + Maximize Conversions aplicados${campaignName ? ` em ${campaignName}` : ""}` });
      qc.invalidateQueries({ queryKey: ["restart-flows"] });
      setOpen(false);
      onChanged?.();
    },
    onError: (e: any) => toast({ title: "Erro ao reiniciar", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const camp = previewQ.data?.campaign;
  const currentCpa = camp?.applied_cpa_brl ?? camp?.current_cpa_brl ?? null;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2 text-xs gap-1"
        title="Reiniciar campanha (esteira manual de recuperação)"
        onClick={() => setOpen(true)}
      >
        <RotateCcw className="h-3.5 w-3.5" /> Reiniciar
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-4 w-4" /> Reiniciar campanha
            </DialogTitle>
            <DialogDescription>
              {campaignName ? <span className="font-medium">{campaignName}</span> : campaignId}
              <span className="block text-xs mt-1">
                Aplica orçamento configurável + Maximizar conversões (sem CPA). Remove a campanha da automação padrão.
              </span>
            </DialogDescription>
          </DialogHeader>

          {/* Controles: período + orçamento */}
          <div className="flex flex-wrap items-end gap-3 border-b border-border pb-3">
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Período</Label>
              <div className="flex gap-1 mt-1">
                {DAY_PRESETS.map((d) => (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={days === d ? "default" : "outline"}
                    className="h-7 px-2 text-xs"
                    onClick={() => setDays(d)}
                  >
                    {d}d
                  </Button>
                ))}
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={days}
                  onChange={(e) => setDays(Math.min(60, Math.max(1, Number(e.target.value) || 7)))}
                  className="h-7 w-16 text-xs"
                />
              </div>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Orçamento ao reiniciar (R$/dia)</Label>
              <Input
                type="number"
                min={1}
                step={1}
                value={budgetBrl}
                onChange={(e) => setBudgetBrl(Math.max(1, Number(e.target.value) || 40))}
                className="h-7 w-24 text-xs mt-1"
              />
            </div>
            <div className="ml-auto grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md border border-border px-2 py-1">
                <div className="text-[10px] uppercase text-muted-foreground">Orçamento atual</div>
                <div className="font-semibold">{camp?.current_budget_brl != null ? fmtCurrency(camp.current_budget_brl) : "—"}</div>
              </div>
              <div className="rounded-md border border-border px-2 py-1">
                <div className="text-[10px] uppercase text-muted-foreground">CPA atual</div>
                <div className="font-semibold">{currentCpa != null && currentCpa > 0 ? fmtCurrency(currentCpa) : "—"}</div>
              </div>
            </div>
          </div>

          {previewQ.isLoading && (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando últimos {days} dias…
            </div>
          )}

          {previewQ.data && (
            <div className="space-y-4">
              {previewQ.data.active_flow && (
                <div className="rounded-md border border-warning/40 bg-warning-soft text-warning px-3 py-2 text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" /> Já existe um fluxo de reinício ativo (estágio:{" "}
                  <code>{previewQ.data.active_flow.stage}</code>). Confirmar irá reaplicar a config inicial.
                </div>
              )}

              <div className="rounded-md border border-border overflow-hidden max-h-[360px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead>Dia</TableHead>
                      <TableHead className="text-right">Custo</TableHead>
                      <TableHead className="text-right">Receita</TableHead>
                      <TableHead className="text-right">Lucro</TableHead>
                      <TableHead className="text-right">ROI</TableHead>
                      <TableHead className="text-right">Conv.</TableHead>
                      <TableHead className="text-right">Impr.</TableHead>
                      <TableHead className="text-right">eCPM</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewQ.data.daily.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                          Sem dados nos últimos {days} dias.
                        </TableCell>
                      </TableRow>
                    )}
                    {previewQ.data.daily.map((d) => (
                      <TableRow key={d.date}>
                        <TableCell className="font-mono text-xs">{d.date}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtCurrency(d.cost)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtCurrency(d.revenue)}</TableCell>
                        <TableCell className={cn("text-right font-semibold tabular-nums", d.profit >= 0 ? "text-success" : "text-danger")}>
                          {fmtCurrency(d.profit)}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums font-semibold", d.roi >= 0 ? "text-success" : "text-danger")}>
                          {fmtPercent(d.roi)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNumber(Math.round(d.conversions))}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNumber(d.impressions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtCurrency(d.ecpm)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-sm">
                <Stat label="Custo total" value={fmtCurrency(previewQ.data.totals.cost)} />
                <Stat label="Receita total" value={fmtCurrency(previewQ.data.totals.revenue)} />
                <Stat label="Conv." value={fmtNumber(Math.round(previewQ.data.totals.conversions))} />
                <Stat label={`ROI ${previewQ.data.days}d`} value={fmtPercent(previewQ.data.totals.roi)} positive={previewQ.data.totals.roi >= 0} />
                <Stat label="CPA médio" value={previewQ.data.totals.cpa > 0 ? fmtCurrency(previewQ.data.totals.cpa) : "—"} />
                <Stat label="eCPM médio" value={previewQ.data.totals.ecpm > 0 ? fmtCurrency(previewQ.data.totals.ecpm) : "—"} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={initMut.isPending}>Cancelar</Button>
            <Button onClick={() => initMut.mutate()} disabled={initMut.isPending}>
              {initMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              Confirmar reinício (R$ {budgetBrl}/dia)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Stat({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("font-semibold tabular-nums", positive == null ? "" : positive ? "text-success" : "text-danger")}>
        {value}
      </div>
    </div>
  );
}

// Hook + badge usados pelo CampaignsTable
export function useRestartFlows() {
  return useQuery({
    queryKey: ["restart-flows"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("campaign_restart_flow")
        .select("campaign_id, stage, status, start_date, current_budget, roi");
      if (error) throw error;
      const map = new Map<string, any>();
      for (const r of data ?? []) {
        const cur = map.get(r.campaign_id);
        const score = (s: string) => (s === "active" ? 3 : s === "recovered" ? 2 : s === "failed" ? 1 : 0);
        if (!cur || score(r.status) > score(cur.status)) map.set(r.campaign_id, r);
      }
      return map;
    },
  });
}

export function RestartStatusBadge({ flow }: { flow: { stage: string; status: string } | undefined }) {
  if (!flow) return null;
  const cfg = badgeFor(flow);
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold", cfg.cls)}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

function badgeFor(f: { stage: string; status: string }) {
  if (f.status === "recovered") return { label: "Recuperada", cls: "bg-success-soft text-success", icon: <CheckCircle2 className="h-3 w-3" /> };
  if (f.status === "failed") return { label: "ROI crítico", cls: "bg-danger-soft text-danger", icon: <AlertTriangle className="h-3 w-3" /> };
  if (f.status === "paused") return { label: "Pausada", cls: "bg-muted text-muted-foreground", icon: <XCircle className="h-3 w-3" /> };
  if (f.stage.includes("phase4")) return { label: "Otimizando", cls: "bg-primary/10 text-primary", icon: <Activity className="h-3 w-3" /> };
  if (f.stage.includes("phase3")) return { label: "Aplicando CPA", cls: "bg-primary/10 text-primary", icon: <Activity className="h-3 w-3" /> };
  if (f.stage.includes("phase2")) return { label: "Recuperando", cls: "bg-primary/10 text-primary", icon: <Activity className="h-3 w-3" /> };
  if (f.stage.includes("phase1") || f.stage.includes("testing")) return { label: "Testando recuperação", cls: "bg-warning-soft text-warning", icon: <AlertTriangle className="h-3 w-3" /> };
  return { label: "Reiniciando", cls: "bg-primary/10 text-primary", icon: <RotateCcw className="h-3 w-3" /> };
}
