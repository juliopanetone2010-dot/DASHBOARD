import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Globe, ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Row {
  campaign_id: string;
  country_code: string;
  country_name: string | null;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  revenue_usd: number;
}

interface Props { fxUsdBrl: number; }
const REV_SHARE_NET = 0.68; // 32% rev share

type SortKey = "cost" | "revenue" | "roi" | "clicks" | "impressions";

export function CountriesTab({ fxUsdBrl }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [campNames, setCampNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lookback, setLookback] = useState(30);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "cost", dir: "desc" });

  const load = async () => {
    setLoading(true);
    try {
      const today = new Date();
      const from = new Date(today.getTime() - lookback * 86400_000).toISOString().slice(0, 10);
      const { data: m } = await supabase
        .from("campaign_country_metrics")
        .select("campaign_id, country_code, country_name, cost, clicks, impressions, conversions, revenue_usd")
        .gte("date", from)
        .limit(50000);
      setRows((m ?? []) as Row[]);
      const ids = [...new Set((m ?? []).map((r) => r.campaign_id))];
      if (ids.length) {
        const { data: cs } = await supabase.from("campaigns").select("campaign_id, name").in("campaign_id", ids);
        const map: Record<string, string> = {};
        for (const c of cs ?? []) map[c.campaign_id] = c.name;
        setCampNames(map);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [lookback]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; rows?: number }>(
        "google-ads-sync-countries",
        { body: { lookback_days: lookback } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao sincronizar", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      toast({ title: "Sincronização concluída", description: `${data?.rows ?? 0} linhas importadas` });
      await load();
    } finally { setSyncing(false); }
  };

  // Agrega por país
  const byCountry = useMemo(() => {
    const m = new Map<string, { code: string; name: string; cost: number; revenue_brl: number; clicks: number; impressions: number; conversions: number; campaigns: Set<string> }>();
    for (const r of rows) {
      let c = m.get(r.country_code);
      if (!c) {
        c = { code: r.country_code, name: r.country_name ?? r.country_code, cost: 0, revenue_brl: 0, clicks: 0, impressions: 0, conversions: 0, campaigns: new Set() };
        m.set(r.country_code, c);
      }
      c.cost += Number(r.cost) || 0;
      c.revenue_brl += (Number(r.revenue_usd) || 0) * REV_SHARE_NET * fxUsdBrl;
      c.clicks += Number(r.clicks) || 0;
      c.impressions += Number(r.impressions) || 0;
      c.conversions += Number(r.conversions) || 0;
      c.campaigns.add(r.campaign_id);
    }
    return [...m.values()].map((c) => {
      const profit = c.revenue_brl - c.cost;
      const roi = c.cost > 0 ? (profit / c.cost) * 100 : 0;
      return { ...c, profit, roi };
    });
  }, [rows, fxUsdBrl]);

  const sorted = useMemo(() => {
    const arr = [...byCountry];
    arr.sort((a, b) => {
      const dir = sort.dir === "desc" ? -1 : 1;
      switch (sort.key) {
        case "cost": return (a.cost - b.cost) * dir;
        case "revenue": return (a.revenue_brl - b.revenue_brl) * dir;
        case "roi": return (a.roi - b.roi) * dir;
        case "clicks": return (a.clicks - b.clicks) * dir;
        case "impressions": return (a.impressions - b.impressions) * dir;
      }
    });
    return arr;
  }, [byCountry, sort]);

  // Por país, lista campanhas com agregação
  const campaignsByCountry = useMemo(() => {
    const m = new Map<string, Map<string, { campaign_id: string; name: string; cost: number; revenue_brl: number }>>();
    for (const r of rows) {
      let cm = m.get(r.country_code);
      if (!cm) { cm = new Map(); m.set(r.country_code, cm); }
      let c = cm.get(r.campaign_id);
      if (!c) {
        c = { campaign_id: r.campaign_id, name: campNames[r.campaign_id] ?? r.campaign_id, cost: 0, revenue_brl: 0 };
        cm.set(r.campaign_id, c);
      }
      c.cost += Number(r.cost) || 0;
      c.revenue_brl += (Number(r.revenue_usd) || 0) * REV_SHARE_NET * fxUsdBrl;
    }
    return m;
  }, [rows, fxUsdBrl, campNames]);

  const toggleExpand = (code: string) => {
    setExpanded((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });
  };

  const SortHead = ({ k, label }: { k: SortKey; label: string }) => {
    const active = sort.key === k;
    const Icon = !active ? ChevronsUpDown : sort.dir === "desc" ? ChevronDown : ChevronUp;
    return (
      <TableHead className={cn("text-right cursor-pointer select-none", active && "bg-primary/5")}
        onClick={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "desc" ? "asc" : "desc" }))}>
        <span className={cn("inline-flex items-center gap-1 ml-auto", active ? "text-foreground font-semibold" : "text-muted-foreground")}>
          {label} <Icon className="h-3 w-3" />
        </span>
      </TableHead>
    );
  };

  const totalCost = sorted.reduce((a, c) => a + c.cost, 0);
  const totalRev = sorted.reduce((a, c) => a + c.revenue_brl, 0);
  const totalProfit = totalRev - totalCost;
  const totalRoi = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        <Globe className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-[260px]">
          <div className="text-sm font-semibold">Performance por país</div>
          <div className="text-xs text-muted-foreground">
            Custo do Google Ads por <code>geo_target_country</code>. Receita do GAM atribuída proporcional ao custo de cada país.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground flex items-center gap-1">
            Janela:
            <select className="h-7 text-xs rounded border border-border bg-background px-2"
              value={lookback} onChange={(e) => setLookback(+e.target.value)}>
              <option value={7}>7 dias</option>
              <option value={15}>15 dias</option>
              <option value={30}>30 dias</option>
              <option value={60}>60 dias</option>
              <option value={90}>90 dias</option>
            </select>
          </label>
          <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <RefreshCw className="h-3.5 w-3.5 mr-2" />}
            Sincronizar
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{sorted.length} países</Badge>
        <Badge variant="outline">Custo: {fmtBRL(totalCost)}</Badge>
        <Badge variant="outline">Receita: {fmtBRL(totalRev)}</Badge>
        <Badge variant={totalProfit >= 0 ? "outline" : "destructive"}>Lucro: {fmtBRL(totalProfit)}</Badge>
        <Badge variant={totalRoi >= 0 ? "outline" : "destructive"}>ROI: {fmtPercent(totalRoi)}</Badge>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-10"></TableHead>
              <TableHead>País</TableHead>
              <TableHead className="text-right">Campanhas</TableHead>
              <SortHead k="cost" label="Custo" />
              <SortHead k="revenue" label="Receita" />
              <TableHead className="text-right">Lucro</TableHead>
              <SortHead k="roi" label="ROI" />
              <SortHead k="clicks" label="Cliques" />
              <SortHead k="impressions" label="Impr." />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={9} className="text-center py-8"><Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Carregando...</TableCell></TableRow>
            )}
            {!loading && sorted.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                Nenhum dado. Clique em <b>Sincronizar</b> para puxar do Google Ads.
              </TableCell></TableRow>
            )}
            {sorted.map((c) => {
              const isOpen = expanded.has(c.code);
              const cmap = campaignsByCountry.get(c.code);
              const camps = cmap ? [...cmap.values()].sort((a, b) => b.cost - a.cost) : [];
              return (
                <Fragment key={c.code}>
                  <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand(c.code)}>
                    <TableCell><span className="text-xs">{isOpen ? "▼" : "▶"}</span></TableCell>
                    <TableCell className="font-medium">
                      <span className="font-mono text-xs text-muted-foreground mr-2">{c.code}</span>
                      {c.name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.campaigns.size}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(c.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(c.revenue_brl)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums font-semibold", c.profit < 0 ? "text-danger" : "text-success")}>{fmtBRL(c.profit)}</TableCell>
                    <TableCell className="text-right">
                      <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                        c.roi >= 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
                        {fmtPercent(c.roi)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(c.clicks)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(c.impressions)}</TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow><TableCell colSpan={9} className="bg-muted/10 p-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Campanha</TableHead>
                            <TableHead className="text-right">Custo</TableHead>
                            <TableHead className="text-right">Receita</TableHead>
                            <TableHead className="text-right">Lucro</TableHead>
                            <TableHead className="text-right">ROI</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {camps.map((cp) => {
                            const profit = cp.revenue_brl - cp.cost;
                            const roi = cp.cost > 0 ? (profit / cp.cost) * 100 : 0;
                            return (
                              <TableRow key={cp.campaign_id}>
                                <TableCell className="text-sm">{cp.name}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(cp.cost)}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(cp.revenue_brl)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums", profit < 0 && "text-danger")}>{fmtBRL(profit)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums font-semibold", roi < 0 ? "text-danger" : "text-success")}>{fmtPercent(roi)}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </TableCell></TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
