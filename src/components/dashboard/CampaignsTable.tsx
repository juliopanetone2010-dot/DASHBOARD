import { useState } from "react";
import { Pause, Play, TrendingUp, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { fmtCurrency, fmtUSD, fmtPercent, fmtNumber } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { CampaignAggregate } from "@/types/domain";

interface Props {
  campaigns: CampaignAggregate[];
  onPause?: (campaignId: string) => void;
  onBoost?: (campaignId: string) => void;
  onRefresh?: () => Promise<void> | void;
}

export function CampaignsTable({ campaigns, onPause, onBoost, onRefresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  const callMutate = async (label: string, body: Record<string, unknown>, key: string) => {
    setBusy(key);
    const { data, error } = await supabase.functions.invoke<{
      ok?: boolean; error?: string; ad_groups_updated?: number; new_status?: string;
    }>("google-ads-mutate", { body });
    setBusy(null);
    if (error || data?.error) {
      toast({
        title: `Erro: ${label}`,
        description: data?.error ?? error?.message ?? "Falha desconhecida",
        variant: "destructive",
      });
      return;
    }
    toast({
      title: label,
      description: data?.new_status
        ? `Status alterado para ${data.new_status}`
        : `${data?.ad_groups_updated ?? 0} ad group(s) atualizados`,
    });
    await onRefresh?.();
  };

  return (
    <div className="rounded-xl border border-border bg-card shadow-elegant overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="w-[120px]">Campaign ID</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead className="text-right">Gasto</TableHead>
              <TableHead className="text-right">Receita</TableHead>
              <TableHead className="text-right">Lucro</TableHead>
              <TableHead className="text-right">ROI</TableHead>
              <TableHead className="text-right">ROAS</TableHead>
              <TableHead className="text-right">Cliques</TableHead>
              <TableHead className="text-right">Conv.</TableHead>
              <TableHead className="w-[180px] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-10">
                  Nenhuma campanha com dados. Conecte uma conta Google Ads na aba "Integrações".
                </TableCell>
              </TableRow>
            )}
            {campaigns.map((c) => {
              const positive = c.profit >= 0;
              const isPaused = c.status === "paused";
              const rowKey = c.campaign_id;
              const loading = busy === rowKey;
              return (
                <TableRow key={c.campaign_id} className="group">
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {c.campaign_id}
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        c.status === "enabled" ? "bg-success" : isPaused ? "bg-warning" : "bg-muted-foreground"
                      )} />
                      <span className="truncate max-w-[240px]">{c.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtCurrency(c.spend)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <div>{fmtUSD(c.revenue)}</div>
                    {c.revenue_brl != null && (
                      <div className="text-[10px] text-muted-foreground">
                        ≈ {fmtCurrency(c.revenue_brl)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-semibold tabular-nums",
                      positive ? "text-success" : "text-danger",
                    )}
                  >
                    {fmtCurrency(c.profit)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                        positive ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                      )}
                    >
                      {fmtPercent(c.roi)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {(Number(c.roas) || 0).toFixed(2)}x
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtNumber(c.clicks)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtNumber(Math.round(c.conversions))}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                      {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <>
                          <Button
                            size="icon"
                            variant="ghost"
                            className={cn(
                              "h-8 w-8",
                              isPaused ? "text-success hover:text-success" : "text-warning hover:text-warning",
                            )}
                            title={isPaused ? "Ativar campanha" : "Pausar campanha"}
                            onClick={() => callMutate(
                              isPaused ? "Campanha ativada" : "Campanha pausada",
                              { action: "set_status", campaign_id: c.campaign_id, status: isPaused ? "ENABLED" : "PAUSED" },
                              rowKey,
                            )}
                          >
                            {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                          </Button>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8 text-primary hover:text-primary"
                                title="Ajustar Target CPA"
                              >
                                <ChevronUp className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuLabel className="text-xs">Ajustar Target CPA</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => callMutate("CPA -20%", { action: "adjust_cpa", campaign_id: c.campaign_id, delta_pct: -20 }, rowKey)}>
                                <ChevronDown className="h-3.5 w-3.5 mr-2 text-success" /> Reduzir 20%
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => callMutate("CPA -10%", { action: "adjust_cpa", campaign_id: c.campaign_id, delta_pct: -10 }, rowKey)}>
                                <ChevronDown className="h-3.5 w-3.5 mr-2 text-success" /> Reduzir 10%
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => callMutate("CPA +10%", { action: "adjust_cpa", campaign_id: c.campaign_id, delta_pct: 10 }, rowKey)}>
                                <ChevronUp className="h-3.5 w-3.5 mr-2 text-warning" /> Aumentar 10%
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => callMutate("CPA +20%", { action: "adjust_cpa", campaign_id: c.campaign_id, delta_pct: 20 }, rowKey)}>
                                <ChevronUp className="h-3.5 w-3.5 mr-2 text-warning" /> Aumentar 20%
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>

                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-success hover:text-success"
                            title="Aumentar orçamento (regra interna)"
                            onClick={() => onBoost?.(c.campaign_id)}
                          >
                            <TrendingUp className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
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
