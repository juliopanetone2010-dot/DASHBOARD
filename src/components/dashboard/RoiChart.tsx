import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyMetric } from "@/types/domain";
import { REV_SHARE_PCT } from "@/engine/rules";

interface Props {
  metrics: DailyMetric[];
}

export function RoiChart({ metrics }: Props) {
  const data = useMemo(() => {
    // m.spend = BRL, m.profit = BRL bruto (rev_brl - spend_brl). Aplicamos rev share aqui
    // para manter consistência com a agregação por campanha (mesma fonte da verdade).
    const byDate = new Map<string, { spend: number; grossProfitBrl: number }>();
    for (const m of metrics) {
      const cur = byDate.get(m.date) ?? { spend: 0, grossProfitBrl: 0 };
      cur.spend += Number(m.spend);
      cur.grossProfitBrl += Number(m.profit);
      byDate.set(m.date, cur);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => {
        const grossRevBrl = v.grossProfitBrl + v.spend;
        const netProfit = v.grossProfitBrl - grossRevBrl * REV_SHARE_PCT;
        return {
          date: date.slice(5),
          roi: v.spend > 0 ? (netProfit / v.spend) * 100 : 0,
          profit: netProfit,
        };
      });
  }, [metrics]);

  return (
    <div className="rounded-xl border border-border bg-card shadow-elegant p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold">ROI ao longo do tempo</h2>
        <span className="text-xs text-muted-foreground">últimos {data.length} dias</span>
      </div>
      <div className="h-[260px]">
        {data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Sem dados ainda.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="roiFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: number, name) =>
                  name === "roi" ? [`${v.toFixed(1)}%`, "ROI"] : [v, name]
                }
              />
              <Area
                type="monotone"
                dataKey="roi"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#roiFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
