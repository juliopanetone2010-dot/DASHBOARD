import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Ban, Loader2, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtPercent } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { REV_SHARE_PCT } from "@/engine/rules";
import { DATE_PRESETS, type DatePresetKey } from "@/components/dashboard/FilterBar";
import type { Campaign, GoogleAccount } from "@/types/domain";

interface AdsPlacementRow {
  id: string;
  placement: string;
  placement_clean: string | null;
  display_name: string | null;
  target_url: string | null;
  placement_type: string | null;
  ad_group_name: string | null;
  campaign_name: string | null;
  campaign_id: string;
  date: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  ctr: number;
  avg_cpc: number;
}

interface GamRevRow { placement: string; revenue_usd: number; impressions: number; date: string; }

interface AggRow {
  placement: string;
  type: string;
  ad_groups: Set<string>;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  revenue: number;        // BRL líquido (estimado via GAM)
  profit: number;
  roi: number;
  ctr: number;
  cpc: number;
}

type SortKey = "roi" | "cost" | "conversions" | "ctr" | "impressions";

interface Props {
  campaigns: Campaign[];
  googleAccounts: GoogleAccount[];
  fxUsdBrl?: number;               // câmbio aproximado (vem da última sync)
}

const PAGE_SIZE = 100;

export function PlacementsTab({ campaigns, googleAccounts, fxUsdBrl = 4.97 }: Props) {
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [campaignId, setCampaignId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [preset, setPreset] = useState<DatePresetKey>("last_7_days");
  const [rows, setRows] = useState<AdsPlacementRow[]>([]);
  const [gamRows, setGamRows] = useState<GamRevRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("roi");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [actions, setActions] = useState<Record<string, "blacklist" | "favorite" | undefined>>({});
  const [showDebug, setShowDebug] = useState(false);

  const visibleCampaigns = useMemo(() => {
    return campaigns
      .filter((c) => accountIds.length === 0 || (c.google_account_id && accountIds.includes(c.google_account_id)))
      .filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.campaign_id.includes(search));
  }, [campaigns, accountIds, search]);

  const fetchPlacements = async (cid: string) => {
    setLoading(true);
    try {
      const range = DATE_PRESETS.find((p) => p.key === preset)!.range();
      const { error } = await supabase.functions.invoke("google-ads-sync-placements", {
        body: { campaign_id: cid, from: range.from, to: range.to },
      });
      if (error) {
        toast({ title: "Erro ao sincronizar", description: error.message, variant: "destructive" });
        return;
      }
      const { data, error: qErr } = await supabase
        .from("ads_placements")
        .select("*")
        .eq("campaign_id", cid)
        .gte("date", range.from)
        .lte("date", range.to)
        .order("date", { ascending: false })
        .limit(5000);
      if (qErr) {
        toast({ title: "Erro ao carregar", description: qErr.message, variant: "destructive" });
        return;
      }
      setRows((data ?? []) as AdsPlacementRow[]);
      setLimit(PAGE_SIZE);

      // Receita do GAM atribuída via UTM (campaign_id + placement)
      const { data: gamData } = await supabase
        .from("gam_placement_revenue")
        .select("placement, revenue_usd, impressions, date")
        .eq("campaign_id", cid)
        .gte("date", range.from)
        .lte("date", range.to);
      setGamRows((gamData ?? []) as GamRevRow[]);

      // Carrega ações (blacklist/favorite) para os placements desta campanha
      const { data: acts } = await supabase
        .from("placement_actions")
        .select("placement, action")
        .eq("campaign_id", cid);
      const map: Record<string, "blacklist" | "favorite"> = {};
      for (const a of acts ?? []) map[(a as any).placement] = (a as any).action;
      setActions(map);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (campaignId) void fetchPlacements(campaignId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, preset]);

  // Receita GAM por placement (já agrupada via UTM no backend)
  const gamRevenueByPlacement = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of gamRows) {
      const key = (g.placement || "").toLowerCase();
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + Number(g.revenue_usd ?? 0));
    }
    return map;
  }, [gamRows]);

  const aggregated: AggRow[] = useMemo(() => {
    const map = new Map<string, AggRow>();
    for (const r of rows) {
      const key = r.placement_clean || r.placement;
      let agg = map.get(key);
      if (!agg) {
        agg = {
          placement: key,
          type: r.placement_type ?? "—",
          ad_groups: new Set(),
          impressions: 0, clicks: 0, cost: 0, conversions: 0,
          revenue: 0, profit: 0, roi: 0, ctr: 0, cpc: 0,
        };
        map.set(key, agg);
      }
      if (r.ad_group_name) agg.ad_groups.add(r.ad_group_name);
      agg.impressions += Number(r.impressions);
      agg.clicks += Number(r.clicks);
      agg.cost += Number(r.cost);
      agg.conversions += Number(r.conversions);
    }
    for (const a of map.values()) {
      const grossUsd = gamRevenueByPlacement.get(a.placement) ?? 0;
      const revBrl = grossUsd * fxUsdBrl * (1 - REV_SHARE_PCT);
      a.revenue = revBrl;
      a.profit = revBrl - a.cost;
      a.roi = a.cost > 0 ? (a.profit / a.cost) * 100 : 0;
      a.ctr = a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0;
      a.cpc = a.clicks > 0 ? a.cost / a.clicks : 0;
    }
    return [...map.values()];
  }, [rows, gamRevenueByPlacement, fxUsdBrl]);

  const sorted = useMemo(() => {
    const arr = [...aggregated];
    arr.sort((a, b) => {
      const va = (a as any)[sortKey] ?? 0;
      const vb = (b as any)[sortKey] ?? 0;
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return arr;
  }, [aggregated, sortKey, sortDir]);

  const visible = sorted.slice(0, limit);
  const hasGamRevenue = gamRevenueByPlacement.size > 0;
  const matchedCount = useMemo(
    () => aggregated.filter((a) => gamRevenueByPlacement.has(a.placement)).length,
    [aggregated, gamRevenueByPlacement],
  );

  const top = useMemo(
    () => [...aggregated].filter((a) => a.cost > 0).sort((a, b) => b.roi - a.roi).slice(0, 5),
    [aggregated],
  );
  const worst = useMemo(
    () => [...aggregated].filter((a) => a.cost > 0).sort((a, b) => a.roi - b.roi).slice(0, 5),
    [aggregated],
  );

  const toggleAction = async (placement: string, action: "blacklist" | "favorite") => {
    const current = actions[placement];
    if (current === action) {
      // remove
      await supabase.from("placement_actions").delete().eq("campaign_id", campaignId).eq("placement", placement).eq("action", action);
      setActions((s) => ({ ...s, [placement]: undefined }));
      return;
    }
    const userRes = await supabase.auth.getUser();
    const uid = userRes.data.user?.id;
    if (!uid) return;
    await supabase.from("placement_actions").insert({ user_id: uid, campaign_id: campaignId, placement, action });
    setActions((s) => ({ ...s, [placement]: action }));
    toast({ title: action === "blacklist" ? "Blacklist registrada" : "Favoritado", description: placement });
  };

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "roi" ? "asc" : "desc"); }
  };

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Conta Ads</label>
            <Select
              value={accountIds.length === 1 ? accountIds[0] : "all"}
              onValueChange={(v) => setAccountIds(v === "all" ? [] : [v])}
            >
              <SelectTrigger className="h-9"><SelectValue placeholder="Todas" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as contas</SelectItem>
                {googleAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.descriptive_name ?? a.account_name ?? a.customer_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Período</label>
            <Select value={preset} onValueChange={(v) => setPreset(v as DatePresetKey)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DATE_PRESETS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground">Buscar campanha</label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome ou ID da campanha..."
              className="h-9"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground">Campanha (obrigatório)</label>
          <div className="flex gap-2">
            <Select value={campaignId} onValueChange={setCampaignId}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Selecione uma campanha" /></SelectTrigger>
              <SelectContent className="max-h-[400px]">
                {visibleCampaigns.length === 0 && (
                  <div className="px-2 py-3 text-sm text-muted-foreground">Nenhuma campanha encontrada.</div>
                )}
                {visibleCampaigns.map((c) => (
                  <SelectItem key={c.campaign_id} value={c.campaign_id}>
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{c.campaign_id}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline" size="sm"
              disabled={!campaignId || loading}
              onClick={() => campaignId && fetchPlacements(campaignId)}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      {!campaignId && (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-10 text-center text-sm text-muted-foreground">
          Selecione uma campanha para carregar os placements.
        </div>
      )}

      {campaignId && (
        <>
          {/* Top / piores */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RankingCard title="🏆 Top placements (ROI)" rows={top} variant="best" hasRevenue={hasGamRevenue} />
            <RankingCard title="💀 Piores placements" rows={worst} variant="worst" hasRevenue={hasGamRevenue} />
          </div>

          {/* Aviso GAM + debug */}
          <div className="flex flex-wrap items-center gap-2">
            {hasGamRevenue ? (
              <Badge variant="outline" className="text-xs">
                Receita atribuída via UTM: {matchedCount}/{aggregated.length} placement(s)
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">
                Sem receita atribuída — GAM não tem ad units com padrão {`{campaignid}_{placement}`} para esta campanha.
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={() => setShowDebug((v) => !v)} className="ml-auto h-7">
              {showDebug ? "Ocultar debug" : "Mostrar debug"}
            </Button>
          </div>
          {showDebug && (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs font-mono space-y-1">
              <div>ads rows: <b>{rows.length}</b> · placements únicos: <b>{aggregated.length}</b></div>
              <div>gam rows (UTM): <b>{gamRows.length}</b> · placements GAM únicos: <b>{gamRevenueByPlacement.size}</b></div>
              <div>matched: <b>{matchedCount}</b> · sem match: <b>{aggregated.length - matchedCount}</b></div>
              <div>fx USD→BRL: <b>{fxUsdBrl}</b> · rev share: <b>{(REV_SHARE_PCT * 100).toFixed(1)}%</b></div>
            </div>
          )}

          {/* Tabela */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">{aggregated.length} placement(s)</h3>
              <div className="text-xs text-muted-foreground">
                Ordenar:{" "}
                <button onClick={() => toggleSort("roi")} className={cn("ml-1 hover:underline", sortKey === "roi" && "text-primary font-medium")}>ROI</button> ·{" "}
                <button onClick={() => toggleSort("cost")} className={cn("hover:underline", sortKey === "cost" && "text-primary font-medium")}>Custo</button> ·{" "}
                <button onClick={() => toggleSort("conversions")} className={cn("hover:underline", sortKey === "conversions" && "text-primary font-medium")}>Conv.</button> ·{" "}
                <button onClick={() => toggleSort("ctr")} className={cn("hover:underline", sortKey === "ctr" && "text-primary font-medium")}>CTR</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Placement</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("impressions")}>Impr.</TableHead>
                    <TableHead className="text-right">Cliques</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("ctr")}>CTR</TableHead>
                    <TableHead className="text-right">CPC</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("conversions")}>Conv.</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("cost")}>Custo</TableHead>
                    <TableHead className="text-right">Receita</TableHead>
                    <TableHead className="text-right">Lucro</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("roi")}>ROI</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.length === 0 && !loading && (
                    <TableRow><TableCell colSpan={12} className="text-center py-8 text-muted-foreground">Sem placements no período.</TableCell></TableRow>
                  )}
                  {loading && (
                    <TableRow><TableCell colSpan={12} className="text-center py-8 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Sincronizando...
                    </TableCell></TableRow>
                  )}
                  {visible.map((r) => {
                    const matched = gamRevenueByPlacement.has(r.placement);
                    const negative = matched && r.roi < 0;
                    const lowCtr = r.impressions > 1000 && r.ctr < 0.3;
                    const wasted = r.cost > 20 && r.conversions === 0;
                    const action = actions[r.placement];
                    return (
                      <TableRow key={r.placement} className={cn(action === "blacklist" && "opacity-50")}>
                        <TableCell className="font-mono text-xs max-w-[260px] truncate" title={r.placement}>
                          {r.placement}
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {!matched && <Badge variant="outline" className="text-[9px]">sem UTM</Badge>}
                            {negative && <Badge variant="destructive" className="text-[9px]">ROI&lt;0</Badge>}
                            {lowCtr && <Badge variant="secondary" className="text-[9px] bg-warning/20 text-warning">CTR baixo</Badge>}
                            {wasted && <Badge variant="secondary" className="text-[9px] bg-warning/20 text-warning">Sem conv.</Badge>}
                            {action === "favorite" && <Badge className="text-[9px] bg-primary/20 text-primary">★ favorito</Badge>}
                            {action === "blacklist" && <Badge variant="destructive" className="text-[9px]">blacklist</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.type}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNumber(r.impressions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNumber(r.clicks)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.ctr.toFixed(2)}%</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtCurrency(r.cpc)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.conversions.toFixed(1)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtCurrency(r.cost)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {matched ? fmtCurrency(r.revenue) : "—"}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums font-medium", matched ? (r.profit >= 0 ? "text-success" : "text-danger") : "text-muted-foreground")}>
                          {matched ? fmtCurrency(r.profit) : "—"}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums font-semibold", matched ? (r.roi >= 0 ? "text-success" : "text-danger") : "text-muted-foreground")}>
                          {matched ? fmtPercent(r.roi) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="icon" variant="ghost" className="h-7 w-7"
                              title="Favoritar"
                              onClick={() => toggleAction(r.placement, "favorite")}
                            >
                              <Star className={cn("h-3.5 w-3.5", action === "favorite" && "fill-primary text-primary")} />
                            </Button>
                            <Button
                              size="icon" variant="ghost" className="h-7 w-7 text-danger"
                              title="Excluir (blacklist)"
                              onClick={() => toggleAction(r.placement, "blacklist")}
                            >
                              <Ban className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {sorted.length > limit && (
              <div className="p-3 border-t border-border flex justify-center">
                <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                  Carregar mais ({sorted.length - limit} restantes)
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RankingCard({ title, rows, variant, hasRevenue }: { title: string; rows: AggRow[]; variant: "best" | "worst"; hasRevenue: boolean }) {
  const Icon = variant === "best" ? ArrowUp : ArrowDown;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      {rows.length === 0 && <div className="text-xs text-muted-foreground py-4">Sem dados.</div>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.placement} className="flex items-center justify-between text-sm">
            <span className="truncate max-w-[60%] font-mono text-xs" title={r.placement}>{r.placement}</span>
            <span className={cn(
              "tabular-nums text-xs flex items-center gap-1",
              hasRevenue ? (r.roi >= 0 ? "text-success" : "text-danger") : "text-muted-foreground",
            )}>
              <Icon className="h-3 w-3" />
              {hasRevenue ? `${r.roi.toFixed(1)}%` : `${fmtCurrency(r.cost)} gasto`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
