import { Pause, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtCurrency, fmtPercent, fmtNumber } from "@/lib/format";
import type { CampaignAggregate } from "@/types/domain";

interface Props {
  campaigns: CampaignAggregate[];
  onPause?: (campaignId: string) => void;
  onBoost?: (campaignId: string) => void;
}

export function CampaignsTable({ campaigns, onPause, onBoost }: Props) {
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
              <TableHead className="w-[120px] text-right">Ações</TableHead>
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
              return (
                <TableRow key={c.campaign_id} className="group">
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {c.campaign_id}
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        c.status === "enabled" ? "bg-success" : c.status === "paused" ? "bg-warning" : "bg-muted-foreground"
                      )} />
                      <span className="truncate max-w-[240px]">{c.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtCurrency(c.spend)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtCurrency(c.revenue)}</TableCell>
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
                    {c.roas.toFixed(2)}x
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtNumber(c.clicks)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtNumber(Math.round(c.conversions))}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-warning hover:text-warning"
                        title="Pausar campanha"
                        onClick={() => onPause?.(c.campaign_id)}
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-success hover:text-success"
                        title="Aumentar orçamento"
                        onClick={() => onBoost?.(c.campaign_id)}
                      >
                        <TrendingUp className="h-3.5 w-3.5" />
                      </Button>
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
