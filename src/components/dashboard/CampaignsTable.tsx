import { Pencil, Trash2 } from "lucide-react";
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
import { fmtCurrency, fmtPercent } from "@/lib/format";
import type { Campaign, CampaignWithMetrics } from "@/types/campaign";
import { CampaignFormDialog } from "./CampaignFormDialog";

interface Props {
  campaigns: CampaignWithMetrics[];
  onUpdate: (c: Campaign) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}

export function CampaignsTable({ campaigns, onUpdate, onDelete }: Props) {
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
              <TableHead className="w-[100px] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                  Nenhuma campanha encontrada com os filtros atuais.
                </TableCell>
              </TableRow>
            )}
            {campaigns.map((c) => {
              const positive = c.profit >= 0;
              return (
                <TableRow key={c.campaignId} className="group">
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.campaignId}</TableCell>
                  <TableCell className="font-medium">{c.name}</TableCell>
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
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                      <CampaignFormDialog
                        initial={c}
                        onSubmit={onUpdate}
                        trigger={
                          <Button size="icon" variant="ghost" className="h-8 w-8">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        }
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-danger hover:text-danger hover:bg-danger-soft"
                        onClick={() => onDelete(c.campaignId)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
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
