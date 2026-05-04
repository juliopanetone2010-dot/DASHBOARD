import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw, AlertTriangle, CheckCircle2, XCircle, Activity } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
};

type PreviewResp = {
  daily: DailyRow[];
  totals: { cost: number; revenue: number; conversions: number; roi: number };
  active_flow: { id: string; stage: string; status: string; start_date: string } | null;
};

export function RestartCampaignButton({ campaignId, campaignName, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const previewQ = useQuery({
    queryKey: ["restart-preview", campaignId],
    enabled: open,
    queryFn: async (): Promise<PreviewResp> => {
      const { data, error } = await supabase.functions.invoke<PreviewResp>("campaign-restart", {
        body: { action: "preview", campaign_id: campaignId },
      });
      if (error) throw error;
      return data!;
    },
  });

  const initMut = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>("campaign-restart", {
        body: { action: "init", campaign_id: campaignId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Reinício iniciado", description: `R$ 40/dia + Maximize Conversions aplicados${campaignName ? ` em ${campaignName}` : ""}` });
      qc.invalidateQueries({ queryKey: ["restart-flows"] });
      setOpen(false);
      onChanged?.();
    },
    onError: (e: any) => toast({ title: "Erro ao reiniciar", description: String(e?.message ?? e), variant: "destructive" }),
  });

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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-4 w-4" /> Reiniciar campanha
            </DialogTitle>
            <DialogDescription>
              {campaignName ? <span className="font-medium">{campaignName}</span> : campaignId}
              <span className="block text-xs mt-1">
                Aplica R$ 40/dia + Maximizar conversões (sem CPA). Remove a campanha da automação padrão.
              </span>
            </DialogDescription>
          </DialogHeader>

          {previewQ.isLoading && (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando últimos 7 dias…
            </div>
          )}

          {previewQ.data && (
            <div className="space-y-4">
              {previewQ.data.active_flow && (
                <div className="rounded-md border border-warning/40 bg-warning-soft text-warning px-3 py-2 text-sm flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" /> Já existe um fluxo de reinício ativo (estágio:{" "}
                  <code>{previewQ.data.active_flow.stage}</code>).
                </div>
              )}

              <div className="rounded-md border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableHead>Dia</TableHead>
                      <TableHead className="text-right">Custo</TableHead>
                      <TableHead className="text-right">Receita</TableHead>
                      <TableHead className="text-right">Lucro</TableHead>
                      <TableHead className="text-right">ROI</TableHead>
                      <TableHead className="text-right">Conv.</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewQ.data.daily.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                          Sem dados nos últimos 7 dias.
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
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="grid grid-cols-4 gap-2 text-sm">
                <Stat label="Custo total" value={fmtCurrency(previewQ.data.totals.cost)} />
                <Stat label="Receita total" value={fmtCurrency(previewQ.data.totals.revenue)} />
                <Stat label="Conv." value={fmtNumber(Math.round(previewQ.data.totals.conversions))} />
                <Stat
                  label="ROI 7d"
                  value={fmtPercent(previewQ.data.totals.roi)}
                  positive={previewQ.data.totals.roi >= 0}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={initMut.isPending}>Cancelar</Button>
            <Button
              onClick={() => initMut.mutate()}
              disabled={initMut.isPending || !!previewQ.data?.active_flow}
            >
              {initMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              Confirmar reinício
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
        // prioriza active > recovered > failed > paused
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
  if (f.status === "failed") return { label: "Falhou", cls: "bg-danger-soft text-danger", icon: <XCircle className="h-3 w-3" /> };
  if (f.status === "paused") return { label: "Pausada", cls: "bg-muted text-muted-foreground", icon: <XCircle className="h-3 w-3" /> };
  // active
  if (f.stage.includes("phase4")) return { label: "Otimizando", cls: "bg-primary/10 text-primary", icon: <Activity className="h-3 w-3" /> };
  if (f.stage.includes("phase3")) return { label: "Aplicando CPA", cls: "bg-primary/10 text-primary", icon: <Activity className="h-3 w-3" /> };
  if (f.stage.includes("phase2")) return { label: "Recuperando", cls: "bg-primary/10 text-primary", icon: <Activity className="h-3 w-3" /> };
  if (f.stage.includes("phase1") || f.stage.includes("testing")) return { label: "Testando recuperação", cls: "bg-warning-soft text-warning", icon: <AlertTriangle className="h-3 w-3" /> };
  return { label: "Reiniciando", cls: "bg-primary/10 text-primary", icon: <RotateCcw className="h-3 w-3" /> };
}
