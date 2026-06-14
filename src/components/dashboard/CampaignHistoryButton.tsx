import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, History } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCurrency, fmtPercent, fmtNumber } from "@/lib/format";
import { calculateCampaignEcpm } from "@/lib/campaignEcpm";
import { cn } from "@/lib/utils";
import { REV_SHARE_PCT, NET_FACTOR } from "@/engine/rules";

interface Props {
  campaignId: string;
  campaignName?: string;
}

const DAY_PRESETS = [7, 15, 30];

type DailyRow = {
  date: string;
  cost: number;
  revenue: number;
  profit: number;
  roi: number;
  conversions: number;
  impressions: number;
  ecpm: number;
  cpa: number;
};

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function CampaignHistoryButton({ campaignId, campaignName }: Props) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(7);

  const from = useMemo(() => isoDaysAgo(days - 1), [days]);
  const to = useMemo(() => isoDaysAgo(0), []);

  const histQ = useQuery({
    queryKey: ["campaign-history", campaignId, days],
    enabled: open,
    queryFn: async () => {
      const [dm, gam, autom, restart, funnel] = await Promise.all([
        supabase
          .from("daily_metrics")
          .select("date, spend, revenue, profit, roi, conversions, impressions")
          .eq("campaign_id", campaignId)
          .gte("date", from)
          .lte("date", to)
          .order("date", { ascending: false }),
        supabase
          .from("gam_placement_revenue")
          .select("date, revenue_usd, impressions")
          .eq("campaign_id", campaignId)
          .gte("date", from)
          .lte("date", to)
          .limit(20000),
        supabase
          .from("campaign_automation")
          .select("last_action, last_action_date, last_cpa_action, last_cpa_action_date, last_scale_date, entered_standby_at")
          .eq("campaign_id", campaignId)
          .maybeSingle(),
        supabase
          .from("campaign_restart_flow")
          .select("stage, status, start_date, last_action, last_action_at")
          .eq("campaign_id", campaignId)
          .order("start_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("campaign_funnel")
          .select("funnel_status, entered_at, last_action, last_evaluated_at")
          .eq("campaign_id", campaignId)
          .maybeSingle(),
      ]);

      // GAM aggregated by day
      const gamByDay = new Map<string, { revenue: number; impressions: number }>();
      for (const r of gam.data ?? []) {
        const k = String((r as any).date);
        const cur = gamByDay.get(k) ?? { revenue: 0, impressions: 0 };
        cur.revenue += Number((r as any).revenue_usd ?? 0);
        cur.impressions += Number((r as any).impressions ?? 0);
        gamByDay.set(k, cur);
      }

      const rows: DailyRow[] = (dm.data ?? []).map((d: any) => {
        const g = gamByDay.get(String(d.date)) ?? { revenue: 0, impressions: 0 };
        const ecpm = calculateCampaignEcpm(g.revenue, g.impressions).ecpm;
        const conv = Number(d.conversions) || 0;
        const cost = Number(d.spend) || 0;
        // Aplica revshare (6,5%) igual ao agregado da tabela de campanhas.
        // daily_metrics.revenue = USD bruto; daily_metrics.profit = BRL bruto (revenue_brl - spend).
        const grossRevUsd = Number(d.revenue) || 0;
        const grossProfitBrl = Number(d.profit) || 0;
        const grossRevBrl = grossProfitBrl + cost;
        const shareBrl = grossRevBrl * REV_SHARE_PCT;
        const netRevUsd = grossRevUsd * NET_FACTOR;
        const netProfit = grossProfitBrl - shareBrl;
        const netRoi = cost > 0 ? (netProfit / cost) * 100 : 0;
        return {
          date: String(d.date),
          cost,
          revenue: netRevUsd,
          profit: netProfit,
          roi: netRoi,
          conversions: conv,
          impressions: Number(g.impressions || d.impressions) || 0,
          ecpm,
          cpa: conv > 0 ? cost / conv : 0,
        };
      });

      // First spend day (ever) for this campaign
      const firstSpend = await supabase
        .from("daily_metrics")
        .select("date")
        .eq("campaign_id", campaignId)
        .gt("spend", 0)
        .order("date", { ascending: true })
        .limit(1)
        .maybeSingle();

      return {
        rows,
        automation: autom.data,
        restart: restart.data,
        funnel: funnel.data,
        firstSpendDate: firstSpend.data?.date ?? null,
      };
    },
  });

  const totals = useMemo(() => {
    const r = histQ.data?.rows ?? [];
    const cost = r.reduce((a, x) => a + x.cost, 0);
    const rev = r.reduce((a, x) => a + x.revenue, 0);
    const conv = r.reduce((a, x) => a + x.conversions, 0);
    const imp = r.reduce((a, x) => a + x.impressions, 0);
    const profit = rev - cost;
    const roi = cost > 0 ? (profit / cost) * 100 : 0;
    return { cost, rev, conv, imp, profit, roi };
  }, [histQ.data]);

  const milestones = useMemo(() => {
    const d = histQ.data;
    if (!d) return [] as { label: string; value: string }[];
    const fmtD = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : "—");
    return [
      { label: "Início do gasto", value: fmtD(d.firstSpendDate) },
      { label: "Entrou no funil", value: fmtD(d.funnel?.entered_at as any) },
      { label: "Última ação automação", value: `${d.automation?.last_action ?? "—"} · ${fmtD(d.automation?.last_action_date as any)}` },
      { label: "Última mudança de CPA", value: `${d.automation?.last_cpa_action ?? "—"} · ${fmtD(d.automation?.last_cpa_action_date as any)}` },
      { label: "Último scale", value: fmtD(d.automation?.last_scale_date as any) },
      { label: "Última reinicialização", value: `${d.restart?.stage ?? "—"} · ${fmtD(d.restart?.last_action_at as any)}` },
    ];
  }, [histQ.data]);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 px-2 text-xs gap-1"
        title="Ver histórico (somente análise)"
        onClick={() => setOpen(true)}
      >
        <History className="h-3.5 w-3.5" /> Histórico
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-4 w-4" /> Histórico da campanha
            </DialogTitle>
            <DialogDescription>
              {campaignName ? <span className="font-medium">{campaignName}</span> : campaignId}
              <span className="block text-xs mt-1">Somente análise — não executa ações. Dados vindos do banco.</span>
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-1 border-b border-border pb-3">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-2">Período</span>
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
          </div>

          {/* Marcos */}
          {histQ.data && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              {milestones.map((m) => (
                <div key={m.label} className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
                  <div className="text-[10px] uppercase text-muted-foreground">{m.label}</div>
                  <div className="font-semibold tabular-nums">{m.value}</div>
                </div>
              ))}
            </div>
          )}

          {histQ.isLoading && (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando últimos {days} dias…
            </div>
          )}

          {histQ.data && (
            <div className="space-y-3">
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
                      <TableHead className="text-right">CPA</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {histQ.data.rows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                          Sem dados nos últimos {days} dias.
                        </TableCell>
                      </TableRow>
                    )}
                    {histQ.data.rows.map((d) => (
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
                        <TableCell className="text-right tabular-nums">{d.ecpm > 0 ? fmtCurrency(d.ecpm) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.cpa > 0 ? fmtCurrency(d.cpa) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-sm">
                <Stat label="Custo total" value={fmtCurrency(totals.cost)} />
                <Stat label="Receita total" value={fmtCurrency(totals.rev)} />
                <Stat label="Lucro" value={fmtCurrency(totals.profit)} positive={totals.profit >= 0} />
                <Stat label={`ROI ${days}d`} value={fmtPercent(totals.roi)} positive={totals.roi >= 0} />
                <Stat label="Conv." value={fmtNumber(Math.round(totals.conv))} />
                <Stat label="Impr." value={fmtNumber(totals.imp)} />
              </div>
            </div>
          )}
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
