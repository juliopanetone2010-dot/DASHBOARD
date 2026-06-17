import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RotateCw, CheckCircle2, XCircle } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { fmtNumber } from "@/lib/format";
import { toast } from "@/hooks/use-toast";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaignId: string;
  campaignName?: string | null;
  from: string;
  to: string;
  siteId?: string;
  dashboardRate: number | null;
  dashboardImpressions: number | null;
  dashboardTotalRequests: number | null;
}

type Row = {
  date: string;
  impressions: number;
  total_requests: number;
  match_rate_pct: number | null;
  source: string;
};

export function MatchRateDebugDialog({
  open, onOpenChange, campaignId, campaignName, from, to, siteId,
  dashboardRate, dashboardImpressions, dashboardTotalRequests,
}: Props) {
  const [syncing, setSyncing] = useState(false);

  const q = useQuery({
    queryKey: ["match-rate-debug", campaignId, from, to],
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await supabase
        .from("gam_campaign_source_revenue")
        .select("date, impressions, total_requests, match_rate_pct")
        .eq("campaign_id", campaignId)
        .eq("utm_source", "google")
        .gte("date", from)
        .lte("date", to)
        .order("date", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        date: String(r.date),
        impressions: Number(r.impressions ?? 0),
        total_requests: Number(r.total_requests ?? 0),
        match_rate_pct: r.match_rate_pct == null ? null : Number(r.match_rate_pct),
        source: r.match_rate_pct != null ? "match_rate" : r.total_requests > 0 ? "ad_requests" : "—",
      }));
    },
    enabled: open && !!campaignId,
    staleTime: 5_000,
  });

  const consolidated = useMemo(() => {
    const rows = q.data ?? [];
    let impSum = 0;
    let reqSum = 0;
    let ratedImp = 0;
    let weighted = 0;
    for (const r of rows) {
      impSum += r.impressions;
      reqSum += r.total_requests;
      if (r.match_rate_pct != null && r.match_rate_pct > 0 && r.impressions > 0) {
        ratedImp += r.impressions;
        weighted += r.match_rate_pct * r.impressions;
      }
    }
    const rateRatio = reqSum > 0 ? (impSum / reqSum) * 100 : null;
    const rateWeighted = ratedImp > 0 ? weighted / ratedImp : null;
    return { impSum, reqSum, ratedImp, weighted, rateRatio, rateWeighted };
  }, [q.data]);

  const expectedDashRate = consolidated.rateWeighted ?? consolidated.rateRatio;
  const diff = expectedDashRate != null && dashboardRate != null
    ? Math.abs(expectedDashRate - dashboardRate)
    : null;
  const matches = diff != null ? diff < 0.1 : null;

  async function handleResync() {
    setSyncing(true);
    try {
      await supabase.functions.invoke("gam-sync-revenue", {
        body: {
          from, to,
          site_id: siteId && siteId !== "all" ? siteId : undefined,
          total_requests_only: true,
          skip_viewability: true,
          skip_snapshot_regen: true,
          sync: true,
        },
      });
      await q.refetch();
      toast({ title: "Sincronização concluída", description: "Dados de match rate atualizados do GAM." });
    } catch (e: any) {
      toast({ title: "Erro ao sincronizar", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Debug Match Rate · {campaignName || campaignId}</DialogTitle>
          <DialogDescription>
            Campaign ID: <code className="font-mono">{campaignId}</code> · Período: {from} → {to}
            <br />
            Fonte: <code className="font-mono">gam_campaign_source_revenue</code> (utm_source=google) — espelha o GAM.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {q.isLoading ? (
            <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
            </div>
          ) : (
            <>
              <div className="rounded border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data</TableHead>
                      <TableHead className="text-right">Matched (impr.)</TableHead>
                      <TableHead className="text-right">Total requests</TableHead>
                      <TableHead className="text-right">Match Rate</TableHead>
                      <TableHead>Fonte</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(q.data ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                          Sem dados de GAM para esta campanha no período.
                        </TableCell>
                      </TableRow>
                    )}
                    {(q.data ?? []).map((r) => (
                      <TableRow key={r.date}>
                        <TableCell className="font-mono">{r.date}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNumber(r.impressions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.total_requests > 0 ? fmtNumber(r.total_requests) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {r.match_rate_pct != null
                            ? `${r.match_rate_pct.toFixed(2)}%`
                            : r.total_requests > 0
                              ? `${((r.impressions / r.total_requests) * 100).toFixed(2)}%`
                              : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.source}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="rounded border p-3 space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Consolidado · Banco (GAM)</div>
                  <div className="font-mono">
                    Matched: <span className="font-semibold">{fmtNumber(consolidated.impSum)}</span><br />
                    Total: <span className="font-semibold">{consolidated.reqSum > 0 ? fmtNumber(consolidated.reqSum) : "—"}</span><br />
                    Rate (Σ/Σ): <span className="font-semibold">{consolidated.rateRatio != null ? `${consolidated.rateRatio.toFixed(2)}%` : "—"}</span><br />
                    Rate (ponderado): <span className="font-semibold">{consolidated.rateWeighted != null ? `${consolidated.rateWeighted.toFixed(2)}%` : "—"}</span>
                  </div>
                </div>
                <div className="rounded border p-3 space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Dashboard (frontend)</div>
                  <div className="font-mono">
                    Matched: <span className="font-semibold">{dashboardImpressions != null ? fmtNumber(dashboardImpressions) : "—"}</span><br />
                    Total: <span className="font-semibold">{dashboardTotalRequests != null ? fmtNumber(dashboardTotalRequests) : "—"}</span><br />
                    Rate exibido: <span className="font-semibold">{dashboardRate != null ? `${dashboardRate.toFixed(2)}%` : "—"}</span><br />
                    {matches === true && (
                      <span className="inline-flex items-center gap-1 text-success">
                        <CheckCircle2 className="h-3.5 w-3.5" /> OK · bate com o banco
                      </span>
                    )}
                    {matches === false && (
                      <span className="inline-flex items-center gap-1 text-danger">
                        <XCircle className="h-3.5 w-3.5" /> DIVERGÊNCIA · Δ {diff!.toFixed(2)} p.p.
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
                  {q.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                  Recarregar do banco
                </Button>
                <Button size="sm" onClick={handleResync} disabled={syncing}>
                  {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RotateCw className="h-3.5 w-3.5 mr-1" />}
                  Re-sincronizar GAM
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
