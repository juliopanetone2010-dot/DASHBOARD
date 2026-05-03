import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Repeat, Sparkles, Wallet, TrendingUp } from "lucide-react";
import { fmtUSD, fmtCurrency } from "@/lib/format";
import { supabase } from "@/integrations/supabase/client";
import type { Campaign } from "@/types/domain";
import { MetricCard } from "./MetricCard";
import { REV_SHARE_PCT } from "@/engine/rules";
import { useDashboardFilters } from "@/contexts/FilterContext";

interface SourceRow {
  id: string;
  campaign_id: string;
  date: string;
  utm_source: string;
  revenue_usd: number;
  impressions: number;
}

interface Props {
  campaigns: Campaign[];
}

export function RetentionTab({ campaigns }: Props) {
  const { range, filters, version } = useDashboardFilters();
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [usdBrl, setUsdBrl] = useState(5);

  const load = async () => {
    setLoading(true);
    setRows([]); // limpa antes para evitar mistura de períodos
    if (import.meta.env.DEV) {
      console.info("[retention] fetch", { range, accounts: filters.googleAccountIds, version });
    }
    let q = supabase
      .from("gam_campaign_source_revenue")
      .select("id, campaign_id, date, utm_source, revenue_usd, impressions")
      .gte("date", range.from)
      .lte("date", range.to)
      .order("date", { ascending: false })
      .limit(5000);
    const { data } = await q;
    setRows((data ?? []) as any);
    // FX rate
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD");
      const j = await r.json();
      const rate = Number(j?.rates?.BRL);
      if (Number.isFinite(rate) && rate > 0) setUsdBrl(rate);
    } catch { /* */ }
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range.from, range.to, version]);

  const campaignName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of campaigns) m.set(c.campaign_id, c.name);
    return m;
  }, [campaigns]);

  // Agrega por (campaign_id, source)
  const byCampaign = useMemo(() => {
    const map = new Map<string, {
      campaign_id: string;
      google: number; push: number; other: number; total: number;
      googleImpr: number; pushImpr: number; otherImpr: number;
    }>();
    for (const r of rows) {
      const cur = map.get(r.campaign_id) ?? {
        campaign_id: r.campaign_id, google: 0, push: 0, other: 0, total: 0,
        googleImpr: 0, pushImpr: 0, otherImpr: 0,
      };
      const usd = Number(r.revenue_usd) || 0;
      const impr = Number(r.impressions) || 0;
      cur.total += usd;
      if (r.utm_source === "google") { cur.google += usd; cur.googleImpr += impr; }
      else if (r.utm_source === "push") { cur.push += usd; cur.pushImpr += impr; }
      else { cur.other += usd; cur.otherImpr += impr; }
      map.set(r.campaign_id, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [rows]);

  const totals = useMemo(() => {
    return byCampaign.reduce((acc, c) => ({
      google: acc.google + c.google,
      push: acc.push + c.push,
      other: acc.other + c.other,
      total: acc.total + c.total,
    }), { google: 0, push: 0, other: 0, total: 0 });
  }, [byCampaign]);

  const net = (usd: number) => usd * (1 - REV_SHARE_PCT) * usdBrl;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Retenção / Push</h2>
          <p className="text-xs text-muted-foreground">
            Receita de usuários retidos via push (sem custo adicional). Comparado ao tráfego pago do Google Ads.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Atualizar
        </Button>
      </div>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Aquisição (Google)"
          value={fmtUSD(totals.google)}
          icon={Wallet}
          hint={`${fmtCurrency(net(totals.google))} líquido (BRL)`}
        />
        <MetricCard
          label="Retenção (Push)"
          value={fmtUSD(totals.push)}
          icon={Repeat}
          variant="primary"
          hint="Sem custo adicional"
        />
        <MetricCard
          label="Outras origens"
          value={fmtUSD(totals.other)}
          icon={Sparkles}
          hint="Orgânico / direto / desconhecido"
        />
        <MetricCard
          label="LTV total (USD)"
          value={fmtUSD(totals.total)}
          icon={TrendingUp}
          variant="success"
          hint={`google + push + outras = ${fmtCurrency(net(totals.total))} líquido`}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>LTV por campanha (últimos 30 dias)</span>
            <Badge variant="outline">{byCampaign.length} campanha(s)</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {byCampaign.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Sem receita atribuída por UTM ainda. Aplique as UTMs nas campanhas e aguarde o tráfego retornar.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campanha</TableHead>
                    <TableHead className="text-right">Google (USD)</TableHead>
                    <TableHead className="text-right">Push (USD)</TableHead>
                    <TableHead className="text-right">Outras</TableHead>
                    <TableHead className="text-right">LTV total</TableHead>
                    <TableHead className="text-right">% Retenção</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byCampaign.map((c) => {
                    const pctPush = c.total > 0 ? (c.push / c.total) * 100 : 0;
                    return (
                      <TableRow key={c.campaign_id}>
                        <TableCell>
                          <div className="font-medium text-sm">
                            {campaignName.get(c.campaign_id) ?? `#${c.campaign_id}`}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono">{c.campaign_id}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtUSD(c.google)}</TableCell>
                        <TableCell className="text-right tabular-nums text-primary">{fmtUSD(c.push)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtUSD(c.other)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{fmtUSD(c.total)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={pctPush > 30 ? "default" : "outline"}>
                            {pctPush.toFixed(1)}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        ⓘ ROI/ROAS na aba Dashboard considera <b>somente</b> receita com <code>utm_source=google</code>.
        Receita de push é retenção (sem custo adicional) e entra apenas no LTV acima.
      </p>
    </div>
  );
}
