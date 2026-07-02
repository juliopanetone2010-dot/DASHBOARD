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
import { buildBestMatch, matchRateColor, stabilityLabel, formatBrDate, BEST_MATCH_WINDOW_DAYS } from "@/lib/bestMatch";
import { buildAdUnitBestMatches, AD_UNIT_MIN_REQUESTS, AD_UNIT_TOP_N } from "@/lib/adUnitMatch";

import { LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, ReferenceLine } from "recharts";

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
  matchedRequests: number;
  totalRequests: number;
  matchRate: number | null;
  matchRateEstimated?: boolean;
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
      const [dm, gam, gamSource, autom, restart, funnel] = await Promise.all([
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
          .from("gam_campaign_source_revenue")
          .select("date, impressions, total_requests, match_rate_pct")
          .eq("campaign_id", campaignId)
          .eq("utm_source", "google")
          .gte("date", from)
          .lte("date", to),
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

      // GAM placement aggregated by day
      const gamByDay = new Map<string, { revenue: number; impressions: number }>();
      for (const r of gam.data ?? []) {
        const k = String((r as any).date);
        const cur = gamByDay.get(k) ?? { revenue: 0, impressions: 0 };
        cur.revenue += Number((r as any).revenue_usd ?? 0);
        cur.impressions += Number((r as any).impressions ?? 0);
        gamByDay.set(k, cur);
      }

      // GAM campaign source (match rate) aggregated by day
      const gamSourceByDay = new Map<string, { impressions: number; totalRequests: number; matchRatePct: number | null }>();
      for (const r of gamSource.data ?? []) {
        const k = String((r as any).date);
        const cur = gamSourceByDay.get(k) ?? { impressions: 0, totalRequests: 0, matchRatePct: null };
        cur.impressions += Number((r as any).impressions ?? 0);
        cur.totalRequests += Number((r as any).total_requests ?? 0);
        const pct = (r as any).match_rate_pct;
        if (pct != null) {
          // keep the latest non-null match_rate_pct for the day (they should be identical per day)
          cur.matchRatePct = Number(pct);
        }
        gamSourceByDay.set(k, cur);
      }

      // Fallback rate: weighted avg of days that DO have match data — used to estimate match rate on days where GAM didn't return total_requests.
      let fbWeighted = 0;
      let fbImp = 0;
      for (const [, v] of gamSourceByDay) {
        if (v.matchRatePct != null && v.impressions > 0) {
          fbWeighted += v.matchRatePct * v.impressions;
          fbImp += v.impressions;
        } else if (v.totalRequests > 0 && v.impressions > 0) {
          fbWeighted += (v.impressions / v.totalRequests) * 100 * v.impressions;
          fbImp += v.impressions;
        }
      }
      const fallbackRate = fbImp > 0 ? fbWeighted / fbImp : null;

      const rows: DailyRow[] = (dm.data ?? []).map((d: any) => {
        const g = gamByDay.get(String(d.date)) ?? { revenue: 0, impressions: 0 };
        const gs = gamSourceByDay.get(String(d.date)) ?? { impressions: 0, totalRequests: 0, matchRatePct: null };
        const ecpm = calculateCampaignEcpm(g.revenue, g.impressions).ecpm;
        const conv = Number(d.conversions) || 0;
        const cost = Number(d.spend) || 0;
        const grossProfitBrl = Number(d.profit) || 0;
        const grossRevBrl = grossProfitBrl + cost;
        const shareBrl = grossRevBrl * REV_SHARE_PCT;
        const netRevBrl = grossRevBrl * NET_FACTOR;
        const netProfit = grossProfitBrl - shareBrl;
        const netRoi = cost > 0 ? (netProfit / cost) * 100 : 0;
        const matchedRequests = gs.impressions;
        let totalRequests = gs.totalRequests;
        let matchRate: number | null = gs.matchRatePct != null
          ? gs.matchRatePct
          : totalRequests > 0
            ? (matchedRequests / totalRequests) * 100
            : null;
        let matchRateEstimated = false;
        if (matchRate == null && matchedRequests > 0 && fallbackRate != null && fallbackRate > 0) {
          matchRate = fallbackRate;
          matchRateEstimated = true;
          if (totalRequests <= 0) totalRequests = Math.round(matchedRequests / (fallbackRate / 100));
        }
        return {
          date: String(d.date),
          cost,
          revenue: netRevBrl,
          profit: netProfit,
          roi: netRoi,
          conversions: conv,
          impressions: Number(g.impressions || d.impressions) || 0,
          ecpm,
          cpa: conv > 0 ? cost / conv : 0,
          matchedRequests,
          totalRequests,
          matchRate,
          matchRateEstimated,
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

  // === Match Ideal (10 dias) — baseado em ROI/lucro, NÃO no maior match ===
  const idealMatchQ = useQuery({
    queryKey: ["campaign-ideal-match", campaignId],
    enabled: open,
    queryFn: async () => {
      const toD = isoDaysAgo(0);
      const fromD = isoDaysAgo(BEST_MATCH_WINDOW_DAYS - 1);
      const [dmRes, gsRes] = await Promise.all([
        supabase
          .from("daily_metrics")
          .select("date, spend, revenue, profit")
          .eq("campaign_id", campaignId)
          .gte("date", fromD)
          .lte("date", toD),
        supabase
          .from("gam_campaign_source_revenue")
          .select("date, impressions, total_requests, match_rate_pct")
          .eq("campaign_id", campaignId)
          .eq("utm_source", "google")
          .gte("date", fromD)
          .lte("date", toD)
          .limit(10000),
      ]);

      const info = buildBestMatch((gsRes.data ?? []).map((r: any) => ({
        date: String(r.date),
        impressions: Number(r.impressions ?? 0),
        total_requests: Number(r.total_requests ?? 0),
        match_rate_pct: r.match_rate_pct == null ? null : Number(r.match_rate_pct),
      })));

      // Financial per day (net, applying rev share) — mesma fórmula do restante do modal
      type PerDay = { date: string; cost: number; revenue: number; profit: number; roi: number; matchRate: number };
      const financialByDate = new Map<string, { cost: number; revenue: number; profit: number; roi: number }>();
      for (const d of (dmRes.data ?? []) as any[]) {
        const cost = Number(d.spend) || 0;
        const grossProfitBrl = Number(d.profit) || 0;
        const grossRevBrl = grossProfitBrl + cost;
        const shareBrl = grossRevBrl * REV_SHARE_PCT;
        const netRevBrl = grossRevBrl * NET_FACTOR;
        const netProfit = grossProfitBrl - shareBrl;
        const netRoi = cost > 0 ? (netProfit / cost) * 100 : 0;
        financialByDate.set(String(d.date), { cost, revenue: netRevBrl, profit: netProfit, roi: netRoi });
      }

      // Junta finance + match rate por dia (apenas dias com custo>0 e match válido)
      const perDay: PerDay[] = [];
      for (const day of info.days) {
        const fin = financialByDate.get(day.date);
        if (!fin || fin.cost <= 0) continue;
        perDay.push({
          date: day.date,
          cost: fin.cost,
          revenue: fin.revenue,
          profit: fin.profit,
          roi: fin.roi,
          matchRate: day.matchRate,
        });
      }

      // Top 3 por ROI
      const sorted = [...perDay].sort((a, b) => b.roi - a.roi);
      const topN = Math.min(3, sorted.length);
      const top = sorted.slice(0, topN);
      const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const idealMatch = top.length ? avg(top.map((x) => x.matchRate)) : null;
      const avgRoi = top.length ? avg(top.map((x) => x.roi)) : null;
      const avgProfit = top.length ? avg(top.map((x) => x.profit)) : null;

      // Desvio padrão do match rate (todos os dias válidos)
      let stdDev: number | null = null;
      if (perDay.length >= 2) {
        const m = avg(perDay.map((x) => x.matchRate));
        const variance = perDay.reduce((a, x) => a + (x.matchRate - m) ** 2, 0) / perDay.length;
        stdDev = Math.sqrt(variance);
      } else if (perDay.length === 1) {
        stdDev = 0;
      }

      // Faixa ideal: min-max de match rates entre dias positivos (profit > 0)
      const positiveDays = perDay.filter((x) => x.profit > 0);
      const positiveRates = positiveDays.map((x) => x.matchRate);
      const idealRange = positiveRates.length
        ? { min: Math.min(...positiveRates), max: Math.max(...positiveRates), count: positiveRates.length }
        : null;

      return {
        info,
        perDay,
        top,
        idealMatch,
        avgRoi,
        avgProfit,
        stdDev,
        idealRange,
        analyzedDays: perDay.length,
        windowDays: BEST_MATCH_WINDOW_DAYS,
      };
    },
  });

  const bestMatchQ = idealMatchQ; // alias para o gráfico reaproveitar info.days

  // === Melhor Match por Ad Unit (últimos 30 dias, isolado por campanha) ===
  const AD_UNIT_WINDOW_DAYS = 30;
  const adUnitMatchQ = useQuery({
    queryKey: ["campaign-ad-unit-match", campaignId],
    enabled: open,
    queryFn: async () => {
      const toD = isoDaysAgo(0);
      const fromD = isoDaysAgo(AD_UNIT_WINDOW_DAYS - 1);

      // 1) Métricas por Ad Unit associadas diretamente ao campaign_id (via KEY_VALUES do GAM)
      const gamRes = await supabase
        .from("gam_url_ad_unit_daily")
        .select("date, ad_unit_name, ad_requests, matched_impressions, revenue_usd, match_rate_pct")
        .eq("campaign_id", campaignId)
        .gte("date", fromD)
        .lte("date", toD)
        .limit(50000);

      // 2) ROI diário da campanha (isolamento)
      const dmRes = await supabase
        .from("daily_metrics")
        .select("date, spend, profit")
        .eq("campaign_id", campaignId)
        .gte("date", fromD)
        .lte("date", toD);

      const campaignDays = ((dmRes.data ?? []) as any[]).map((d) => {
        const cost = Number(d.spend) || 0;
        const grossProfitBrl = Number(d.profit) || 0;
        const grossRevBrl = grossProfitBrl + cost;
        const shareBrl = grossRevBrl * REV_SHARE_PCT;
        const netProfit = grossProfitBrl - shareBrl;
        const netRoi = cost > 0 ? (netProfit / cost) * 100 : 0;
        return { date: String(d.date), cost, netRoi, netProfit };
      });

      const rows = ((gamRes.data ?? []) as any[]).map((r) => ({
        date: String(r.date),
        ad_unit_name: String(r.ad_unit_name ?? ""),
        ad_requests: Number(r.ad_requests ?? 0),
        matched_impressions: Number(r.matched_impressions ?? 0),
        revenue_usd: Number(r.revenue_usd ?? 0),
        match_rate_pct: r.match_rate_pct == null ? null : Number(r.match_rate_pct),
      }));

      const adUnits = buildAdUnitBestMatches(rows, campaignDays);
      return { rows: gamRes.data ?? [], adUnits, urlCount: rows.length > 0 ? 1 : 0, hasUrls: rows.length > 0 };
    },
  });





  const chartData = useMemo(() => {
    const d = idealMatchQ.data?.info.days ?? [];
    return [...d].reverse().map((x) => ({
      date: formatBrDate(x.date),
      fullDate: x.date,
      rate: Number(x.matchRate.toFixed(2)),
      matched: x.matched,
      requests: x.requests,
    }));
  }, [idealMatchQ.data]);

  function stdDevLabel(sd: number | null): { label: string; className: string } {
    if (sd == null) return { label: "—", className: "text-muted-foreground" };
    if (sd < 2) return { label: "Muito estável", className: "text-emerald-600 dark:text-emerald-400" };
    if (sd < 5) return { label: "Estável", className: "text-green-600 dark:text-green-400" };
    if (sd < 10) return { label: "Oscilando", className: "text-yellow-600 dark:text-yellow-400" };
    return { label: "Muito instável", className: "text-red-600 dark:text-red-400" };
  }

  const totals = useMemo(() => {
    const r = histQ.data?.rows ?? [];
    const cost = r.reduce((a, x) => a + x.cost, 0);
    const rev = r.reduce((a, x) => a + x.revenue, 0);
    const conv = r.reduce((a, x) => a + x.conversions, 0);
    const imp = r.reduce((a, x) => a + x.impressions, 0);
    const profit = rev - cost;
    const roi = cost > 0 ? (profit / cost) * 100 : 0;
    const matched = r.reduce((a, x) => a + x.matchedRequests, 0);
    const requests = r.reduce((a, x) => a + x.totalRequests, 0);
    let weightedRate = 0;
    let ratedImp = 0;
    for (const x of r) {
      if (x.matchRate != null && x.matchedRequests > 0) {
        weightedRate += x.matchRate * x.matchedRequests;
        ratedImp += x.matchedRequests;
      }
    }
    const matchRate = ratedImp > 0 ? weightedRate / ratedImp : (requests > 0 ? (matched / requests) * 100 : null);
    return { cost, rev, conv, imp, profit, roi, matched, requests, matchRate };
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
        <DialogContent className="max-w-6xl">
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

          {/* Match Ideal + Estabilidade + Faixa ideal + gráfico (últimos 10 dias) */}
          {idealMatchQ.data && idealMatchQ.data.info.days.length > 0 && (() => {
            const d = idealMatchQ.data;
            const stab = stdDevLabel(d.stdDev);
            const ideal = d.idealMatch;
            const best = d.info.best;
            return (
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <div className="rounded-md border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Melhor Match (10 dias)</div>
                  <div className={cn("text-2xl font-bold tabular-nums", matchRateColor(best?.matchRate ?? null))}>
                    {best ? `${best.matchRate.toFixed(2)}%` : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {best ? `Dia: ${formatBrDate(best.date)} (${best.date})` : "Sem dados"}
                  </div>
                  {best && (
                    <>
                      <div className="text-xs text-muted-foreground">
                        Matched: <span className="font-medium text-foreground tabular-nums">{best.matched.toLocaleString()}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Requests: <span className="font-medium text-foreground tabular-nums">{best.requests.toLocaleString()}</span>
                      </div>
                    </>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">
                    Mesmo valor da coluna da tabela.
                  </div>
                </div>

                <div className="rounded-md border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Match ideal (10 dias)</div>
                  <div className={cn("text-2xl font-bold tabular-nums", matchRateColor(ideal))}>
                    {ideal != null ? `${ideal.toFixed(1)}%` : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Baseado nos {d.top.length} melhores dias
                  </div>
                  <div className="text-xs text-muted-foreground">
                    ROI médio: <span className="font-medium text-foreground tabular-nums">
                      {d.avgRoi != null ? `${d.avgRoi.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Lucro médio: <span className="font-medium text-foreground tabular-nums">
                      {d.avgProfit != null ? fmtCurrency(d.avgProfit) : "—"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Dias analisados: <span className="font-medium text-foreground tabular-nums">{d.analyzedDays}/{d.windowDays}</span>
                  </div>
                </div>

                <div className="rounded-md border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Faixa ideal de Match</div>
                  <div className="text-2xl font-bold tabular-nums">
                    {d.idealRange
                      ? `${d.idealRange.min.toFixed(1)}% – ${d.idealRange.max.toFixed(1)}%`
                      : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {d.idealRange
                      ? <>Baseado em <span className="font-medium text-foreground">{d.idealRange.count}</span> dias positivos (lucro &gt; 0)</>
                      : "Nenhum dia positivo no período"}
                  </div>
                </div>

                <div className="rounded-md border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Estabilidade do Match</div>
                  <div className={cn("text-2xl font-bold", stab.className)}>{stab.label}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Desvio padrão: <span className="font-medium text-foreground tabular-nums">
                      {d.stdDev != null ? `${d.stdDev.toFixed(2)} pp` : "—"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Δ máx-mín: <span className="font-medium text-foreground tabular-nums">
                      {d.info.stabilityDelta != null ? `${d.info.stabilityDelta.toFixed(2)} pp` : "—"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Faixa total: <span className="tabular-nums">{d.info.minRate?.toFixed(1)}% – {d.info.maxRate?.toFixed(1)}%</span>
                  </div>
                </div>

                <div className="rounded-md border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                    Match Rate diário (10d) {ideal != null && <span className="normal-case">· linha = ideal {ideal.toFixed(1)}%</span>}
                  </div>
                  <div className="h-[130px] -mx-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} width={28} stroke="hsl(var(--muted-foreground))" />
                        <RTooltip
                          contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", fontSize: 11 }}
                          formatter={(v: any) => [`${v}%`, "Match"]}
                          labelFormatter={(l) => `Dia ${l}`}
                        />
                        {ideal != null && (
                          <ReferenceLine
                            y={Number(ideal.toFixed(2))}
                            stroke="hsl(var(--success))"
                            strokeDasharray="4 3"
                            label={{ value: `Ideal ${ideal.toFixed(1)}%`, fill: "hsl(var(--success))", fontSize: 10, position: "insideTopRight" }}
                          />
                        )}
                        <Line type="monotone" dataKey="rate" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Melhor Match por Ad Unit (Bloco de Anúncios) — últimos 30 dias */}
          {adUnitMatchQ.isLoading && (
            <div className="rounded-md border border-border p-3 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando Ad Units do Google Ad Manager…
            </div>
          )}
          {adUnitMatchQ.data && (
            <div className="rounded-md border border-border">
              <div className="p-3 border-b border-border flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">Melhor Match por Bloco (Ad Unit) — {AD_UNIT_WINDOW_DAYS} dias</div>
                  <div className="text-[11px] text-muted-foreground">
                    Cruzamento GAM <code>utm_campaign={campaignId}</code> × Ad Unit · min {AD_UNIT_MIN_REQUESTS} requests/dia · média dos top {AD_UNIT_TOP_N} dias por ROI
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground text-right">
                  Blocos encontrados: <span className="font-medium text-foreground">{adUnitMatchQ.data.adUnits.length}</span>
                </div>
              </div>
              {adUnitMatchQ.data.adUnits.length === 0 ? (
                <div className="p-4 text-xs text-muted-foreground text-center">
                  {adUnitMatchQ.data.rows.length === 0
                    ? "Sem dados no GAM para esta campanha nos últimos 30 dias. Aguarde o próximo sync (GAM key-values × Ad Unit)."
                    : `Sem Ad Units elegíveis (mínimo ${AD_UNIT_MIN_REQUESTS} requests em dias com custo>0).`}
                </div>
              ) : (
                <div className="max-h-[360px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableHead>Bloco (Ad Unit)</TableHead>
                        <TableHead className="text-right">Dias</TableHead>
                        <TableHead className="text-right">Match médio</TableHead>
                        <TableHead className="text-right">Fill médio</TableHead>
                        <TableHead className="text-right">eCPM médio</TableHead>
                        <TableHead className="text-right">Receita/dia</TableHead>
                        <TableHead className="text-right">ROI médio</TableHead>
                        <TableHead>Melhores dias</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {adUnitMatchQ.data.adUnits.map((au) => (
                        <TableRow key={au.adUnitName}>
                          <TableCell className="font-mono text-[11px] break-all max-w-[260px]">{au.adUnitName}</TableCell>
                          <TableCell className="text-right tabular-nums text-xs">
                            {au.eligibleDays}/{au.totalDays}
                          </TableCell>
                          <TableCell className={cn("text-right tabular-nums font-semibold", matchRateColor(au.bestMatchAvg))}>
                            {au.bestMatchAvg != null ? `${au.bestMatchAvg.toFixed(2)}%` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-xs">
                            {au.avgFillRate != null ? `${au.avgFillRate.toFixed(2)}%` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-xs font-semibold">
                            {au.avgEcpm != null ? `US$ ${au.avgEcpm.toFixed(2)}` : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-xs">
                            {au.avgRevenueUsd != null ? `US$ ${au.avgRevenueUsd.toFixed(2)}` : "—"}
                          </TableCell>
                          <TableCell className={cn("text-right tabular-nums", (au.avgRoi ?? 0) >= 0 ? "text-success" : "text-danger")}>
                            {au.avgRoi != null ? fmtPercent(au.avgRoi) : "—"}
                          </TableCell>
                          <TableCell className="text-[11px] text-muted-foreground">
                            {au.topDays.map((d) => (
                              <div key={d.date} className="tabular-nums">
                                {formatBrDate(d.date)}: <span className="font-medium text-foreground">{d.matchRate.toFixed(1)}%</span>
                                {" "}· eCPM US$ {d.ecpm.toFixed(2)} · ROI {d.roi.toFixed(0)}% · {d.adRequests.toLocaleString()} req
                              </div>
                            ))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
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
                      <TableHead className="text-right">Matched</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                      <TableHead className="text-right">Match Rate</TableHead>
                      <TableHead className="text-right">eCPM</TableHead>
                      <TableHead className="text-right">CPA</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {histQ.data.rows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={12} className="text-center text-muted-foreground py-6">
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
                        <TableCell className="text-right tabular-nums">{d.matchedRequests > 0 ? fmtNumber(d.matchedRequests) : "—"}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", d.matchRateEstimated && "text-muted-foreground italic")} title={d.matchRateEstimated ? "GAM não retornou total_requests para esta data — estimado pelo total_requests do período" : undefined}>
                          {d.totalRequests > 0 ? (d.matchRateEstimated ? `~${fmtNumber(d.totalRequests)}` : fmtNumber(d.totalRequests)) : "—"}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums font-medium", d.matchRateEstimated && "text-muted-foreground italic")} title={d.matchRateEstimated ? "Estimado (média ponderada dos dias com dados de match no período)" : undefined}>
                          {d.matchRate != null ? `${d.matchRateEstimated ? "~" : ""}${d.matchRate.toFixed(2)}%` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{d.ecpm > 0 ? fmtCurrency(d.ecpm) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.cpa > 0 ? fmtCurrency(d.cpa) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="grid grid-cols-3 md:grid-cols-8 gap-2 text-sm">
                <Stat label="Custo total" value={fmtCurrency(totals.cost)} />
                <Stat label="Receita total" value={fmtCurrency(totals.rev)} />
                <Stat label="Lucro" value={fmtCurrency(totals.profit)} positive={totals.profit >= 0} />
                <Stat label={`ROI ${days}d`} value={fmtPercent(totals.roi)} positive={totals.roi >= 0} />
                <Stat label="Conv." value={fmtNumber(Math.round(totals.conv))} />
                <Stat label="Impr." value={fmtNumber(totals.imp)} />
                <Stat label="Matched" value={totals.matched > 0 ? fmtNumber(totals.matched) : "—"} />
                <Stat label="Match Rate" value={totals.matchRate != null ? `${totals.matchRate.toFixed(2)}%` : "—"} />
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
