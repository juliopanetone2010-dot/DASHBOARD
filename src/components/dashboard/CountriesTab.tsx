import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Globe, ChevronDown, ChevronUp, ChevronsUpDown, Ban, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NET_FACTOR } from "@/engine/rules";
import { useDashboardData } from "@/hooks/useDashboardData";
import { DATE_PRESETS, type DatePresetKey } from "@/components/dashboard/FilterBar";

interface CountryRow {
  campaign_id: string;
  date: string;
  country_code: string;
  country_name: string | null;
  country_criterion_id: string | null;
  google_account_id: string | null;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
}

interface DailyRev {
  campaign_id: string;
  date: string;
  spend: number;       // BRL
  revenue_usd: number; // USD bruto
}

interface Props { fxUsdBrl: number; }

type SortKey = "cost" | "revenue" | "roi" | "clicks" | "impressions";
type ViewMode = "country" | "campaign";

export function CountriesTab({ fxUsdBrl }: Props) {
  const dash = useDashboardData();

  const [preset, setPreset] = useState<DatePresetKey>("yesterday");
  const [accountIds, setAccountIds] = useState<string[]>([]); // empty = all
  const [siteId, setSiteId] = useState<string>("all");
  const [view, setView] = useState<ViewMode>("country");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "cost", dir: "desc" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [excluding, setExcluding] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [countryRows, setCountryRows] = useState<CountryRow[]>([]);
  const [dailyRows, setDailyRows] = useState<DailyRev[]>([]);
  const [campNames, setCampNames] = useState<Record<string, string>>({});

  // Período derivado do preset
  const range = useMemo(() => {
    const p = DATE_PRESETS.find((d) => d.key === preset);
    return p ? p.range() : DATE_PRESETS[1].range();
  }, [preset]);

  // Contas vinculadas ao site (se filtrar site)
  const visibleAccounts = useMemo(() => {
    if (siteId === "all") return dash.googleAccounts;
    const linked = new Set(dash.links.filter((l) => l.site_id === siteId).map((l) => l.google_account_id));
    return dash.googleAccounts.filter((a) => linked.has(a.id));
  }, [dash.googleAccounts, dash.links, siteId]);

  const effectiveAccountIds = useMemo(() => {
    if (accountIds.length > 0) return accountIds;
    if (siteId === "all") return [];
    return visibleAccounts.map((a) => a.id);
  }, [accountIds, siteId, visibleAccounts]);

  const load = async () => {
    setLoading(true);
    try {
      // 1) Custo/cliques/impressões por (campanha, país, dia)
      let cQ = supabase
        .from("campaign_country_metrics")
        .select("campaign_id, date, country_code, country_name, country_criterion_id, google_account_id, cost, clicks, impressions, conversions")
        .gte("date", range.from)
        .lte("date", range.to);
      if (effectiveAccountIds.length > 0) cQ = cQ.in("google_account_id", effectiveAccountIds);
      const { data: cm, error: cErr } = await cQ.limit(50000);
      if (cErr) {
        toast({ title: "Erro ao carregar países", description: cErr.message, variant: "destructive" });
        setCountryRows([]); setDailyRows([]);
        return;
      }
      const rows = (cm ?? []) as CountryRow[];
      setCountryRows(rows);

      // 2) Receita por (campanha, dia) — MESMA fonte do dashboard
      const ids = [...new Set(rows.map((r) => r.campaign_id))];
      if (ids.length === 0) { setDailyRows([]); setCampNames({}); return; }

      const dailyAll: DailyRev[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        let dQ = supabase
          .from("daily_metrics")
          .select("campaign_id, date, spend, revenue")
          .in("campaign_id", chunk)
          .gte("date", range.from)
          .lte("date", range.to);
        if (effectiveAccountIds.length > 0) dQ = dQ.in("google_account_id", effectiveAccountIds);
        const { data } = await dQ.limit(50000);
        for (const r of data ?? []) {
          dailyAll.push({
            campaign_id: String(r.campaign_id),
            date: String(r.date),
            spend: Number(r.spend) || 0,
            revenue_usd: Number(r.revenue) || 0,
          });
        }
      }
      setDailyRows(dailyAll);

      // 3) Nomes de campanha
      const names: Record<string, string> = {};
      for (const c of dash.campaigns) names[c.campaign_id] = c.name;
      setCampNames(names);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, effectiveAccountIds.join("|"), siteId]);

  const sync = async () => {
    setSyncing(true);
    try {
      // calcula lookback aproximado a partir do range
      const days = Math.max(1, Math.ceil((+new Date(range.to) - +new Date(range.from)) / 86400_000) + 1);
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; rows?: number }>(
        "google-ads-sync-countries",
        { body: { lookback_days: days } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao sincronizar", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      toast({ title: "Sincronização concluída", description: `${data?.rows ?? 0} linhas importadas` });
      await load();
    } finally { setSyncing(false); }
  };

  // ============= AGREGAÇÃO =============
  // Estratégia: para cada (campaign,date), pegamos a receita BRUTA em USD do daily_metrics
  // e distribuímos por país proporcional ao custo daquele país naquele dia.
  // Garante que o total = total do dashboard.

  const { byCountry, byCampaign, countriesByCampaign, campaignsByCountry, debugTotals } = useMemo(() => {
    // Totais por (camp,date) para escolher a base de rateio
    // Ordem de preferência: conversões → cliques → impressões → custo (último recurso)
    const convByCampDate = new Map<string, number>();
    const clicksByCampDate = new Map<string, number>();
    const imprByCampDate = new Map<string, number>();
    const costByCampDate = new Map<string, number>();
    for (const r of countryRows) {
      const k = `${r.campaign_id}|${r.date}`;
      convByCampDate.set(k, (convByCampDate.get(k) ?? 0) + (Number(r.conversions) || 0));
      clicksByCampDate.set(k, (clicksByCampDate.get(k) ?? 0) + (Number(r.clicks) || 0));
      imprByCampDate.set(k, (imprByCampDate.get(k) ?? 0) + (Number(r.impressions) || 0));
      costByCampDate.set(k, (costByCampDate.get(k) ?? 0) + (Number(r.cost) || 0));
    }
    // index receita por (camp,date) — daily_metrics
    const revByCampDate = new Map<string, number>();
    for (const r of dailyRows) {
      const k = `${r.campaign_id}|${r.date}`;
      revByCampDate.set(k, (revByCampDate.get(k) ?? 0) + (Number(r.revenue_usd) || 0));
    }

    interface CCAcc {
      campaign_id: string;
      country_code: string;
      country_name: string;
      country_criterion_id: string | null;
      cost: number;
      revenue_brl: number;
      clicks: number;
      impressions: number;
      conversions: number;
    }
    const cellMap = new Map<string, CCAcc>();
    for (const r of countryRows) {
      const k = `${r.campaign_id}|${r.country_code}`;
      let cell = cellMap.get(k);
      if (!cell) {
        cell = {
          campaign_id: r.campaign_id,
          country_code: r.country_code,
          country_name: r.country_name ?? r.country_code,
          country_criterion_id: r.country_criterion_id,
          cost: 0, revenue_brl: 0, clicks: 0, impressions: 0, conversions: 0,
        };
        cellMap.set(k, cell);
      }
      const cost = Number(r.cost) || 0;
      const conv = Number(r.conversions) || 0;
      const clicks = Number(r.clicks) || 0;
      const impr = Number(r.impressions) || 0;
      cell.cost += cost;
      cell.clicks += clicks;
      cell.impressions += impr;
      cell.conversions += conv;

      const cdKey = `${r.campaign_id}|${r.date}`;
      const revUsd = revByCampDate.get(cdKey) || 0;
      if (revUsd > 0) {
        // Escolhe a base de rateio com fallback: conversões → cliques → impressões → custo
        const totalConv = convByCampDate.get(cdKey) || 0;
        const totalClicks = clicksByCampDate.get(cdKey) || 0;
        const totalImpr = imprByCampDate.get(cdKey) || 0;
        const totalCost = costByCampDate.get(cdKey) || 0;
        let share = 0;
        if (totalConv > 0) share = conv / totalConv;
        else if (totalClicks > 0) share = clicks / totalClicks;
        else if (totalImpr > 0) share = impr / totalImpr;
        else if (totalCost > 0) share = cost / totalCost;
        if (share > 0) {
          cell.revenue_brl += revUsd * share * NET_FACTOR * fxUsdBrl;
        }
      }
      if (!cell.country_criterion_id && r.country_criterion_id) {
        cell.country_criterion_id = r.country_criterion_id;
      }
    }

    // Por país
    const byCountryMap = new Map<string, {
      code: string; name: string; cost: number; revenue_brl: number;
      clicks: number; impressions: number; conversions: number; campaigns: Set<string>;
    }>();
    for (const cell of cellMap.values()) {
      let c = byCountryMap.get(cell.country_code);
      if (!c) {
        c = { code: cell.country_code, name: cell.country_name, cost: 0, revenue_brl: 0, clicks: 0, impressions: 0, conversions: 0, campaigns: new Set() };
        byCountryMap.set(cell.country_code, c);
      }
      c.cost += cell.cost;
      c.revenue_brl += cell.revenue_brl;
      c.clicks += cell.clicks;
      c.impressions += cell.impressions;
      c.conversions += cell.conversions;
      c.campaigns.add(cell.campaign_id);
    }
    const byCountry = [...byCountryMap.values()].map((c) => {
      const profit = c.revenue_brl - c.cost;
      const roi = c.cost > 0 ? (profit / c.cost) * 100 : 0;
      return { ...c, profit, roi };
    });

    // Por campanha
    const byCampaignMap = new Map<string, {
      campaign_id: string; name: string; cost: number; revenue_brl: number;
      clicks: number; impressions: number; countries: Set<string>;
    }>();
    for (const cell of cellMap.values()) {
      let c = byCampaignMap.get(cell.campaign_id);
      if (!c) {
        c = { campaign_id: cell.campaign_id, name: campNames[cell.campaign_id] ?? cell.campaign_id, cost: 0, revenue_brl: 0, clicks: 0, impressions: 0, countries: new Set() };
        byCampaignMap.set(cell.campaign_id, c);
      }
      c.cost += cell.cost;
      c.revenue_brl += cell.revenue_brl;
      c.clicks += cell.clicks;
      c.impressions += cell.impressions;
      c.countries.add(cell.country_code);
    }
    const byCampaign = [...byCampaignMap.values()].map((c) => {
      const profit = c.revenue_brl - c.cost;
      const roi = c.cost > 0 ? (profit / c.cost) * 100 : 0;
      return { ...c, profit, roi };
    });

    // Listas para expand
    const countriesByCampaign = new Map<string, Array<CCAcc & { profit: number; roi: number }>>();
    const campaignsByCountry = new Map<string, Array<CCAcc & { profit: number; roi: number; name: string }>>();
    for (const cell of cellMap.values()) {
      const profit = cell.revenue_brl - cell.cost;
      const roi = cell.cost > 0 ? (profit / cell.cost) * 100 : 0;
      const enriched = { ...cell, profit, roi, name: campNames[cell.campaign_id] ?? cell.campaign_id };
      const arr1 = countriesByCampaign.get(cell.campaign_id) ?? [];
      arr1.push(enriched);
      countriesByCampaign.set(cell.campaign_id, arr1);
      const arr2 = campaignsByCountry.get(cell.country_code) ?? [];
      arr2.push(enriched);
      campaignsByCountry.set(cell.country_code, arr2);
    }
    for (const arr of countriesByCampaign.values()) arr.sort((a, b) => b.cost - a.cost);
    for (const arr of campaignsByCountry.values()) arr.sort((a, b) => b.cost - a.cost);

    // Debug totais
    const totalCost = byCountry.reduce((a, c) => a + c.cost, 0);
    const totalRev = byCountry.reduce((a, c) => a + c.revenue_brl, 0);
    const debugTotals = byCountry
      .map((c) => ({ ...c, sharePct: totalCost > 0 ? (c.cost / totalCost) * 100 : 0 }))
      .sort((a, b) => b.cost - a.cost);

    return { byCountry, byCampaign, countriesByCampaign, campaignsByCountry, debugTotals, totalCost, totalRev };
  }, [countryRows, dailyRows, fxUsdBrl, campNames]);

  const sortFn = (a: { cost: number; revenue_brl: number; roi: number; clicks: number; impressions: number },
                  b: { cost: number; revenue_brl: number; roi: number; clicks: number; impressions: number }) => {
    const dir = sort.dir === "desc" ? -1 : 1;
    switch (sort.key) {
      case "cost": return (a.cost - b.cost) * dir;
      case "revenue": return (a.revenue_brl - b.revenue_brl) * dir;
      case "roi": return (a.roi - b.roi) * dir;
      case "clicks": return (a.clicks - b.clicks) * dir;
      case "impressions": return (a.impressions - b.impressions) * dir;
    }
  };

  const sortedCountries = useMemo(() => [...byCountry].sort(sortFn), [byCountry, sort]);
  const sortedCampaigns = useMemo(() => [...byCampaign].sort(sortFn), [byCampaign, sort]);

  const totalCost = sortedCountries.reduce((a, c) => a + c.cost, 0);
  const totalRev = sortedCountries.reduce((a, c) => a + c.revenue_brl, 0);
  const totalProfit = totalRev - totalCost;
  const totalRoi = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;

  const handleExclude = async (campaignId: string, criterionId: string | null, countryName: string) => {
    if (!criterionId) {
      toast({ title: "Sem ID do país", description: "Sincronize de novo para obter o ID do critério.", variant: "destructive" });
      return;
    }
    setExcluding(`${campaignId}|${criterionId}`);
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
        "google-ads-mutate",
        { body: { action: "exclude_country", campaign_id: campaignId, country_criterion_id: criterionId } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao excluir país", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      toast({ title: "País excluído", description: `${countryName} adicionado como exclusão na campanha.` });
    } finally { setExcluding(null); }
  };

  const toggleExpand = (k: string) => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleAccount = (id: string) => setAccountIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const accountLabel = accountIds.length === 0
    ? (siteId === "all" ? "Todas as contas" : `Todas do site (${visibleAccounts.length})`)
    : accountIds.length === 1
      ? (dash.googleAccounts.find((a) => a.id === accountIds[0])?.account_name ?? "1 selecionada")
      : `${accountIds.length} selecionadas`;

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

  return (
    <div className="space-y-4">
      {/* Header + filtros */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Globe className="h-5 w-5 text-primary" />
          <div className="flex-1 min-w-[260px]">
            <div className="text-sm font-semibold">Performance por país</div>
            <div className="text-xs text-muted-foreground">
              Custo do Google Ads por país. Receita do GAM (mesma fonte da Dashboard) distribuída
              proporcional ao custo de cada país. Rev share aplicado: {((1 - NET_FACTOR) * 100).toFixed(1)}%.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant={showDebug ? "default" : "outline"} onClick={() => setShowDebug((s) => !s)}>
              <Bug className="h-3.5 w-3.5 mr-1" /> Debug
            </Button>
            <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <RefreshCw className="h-3.5 w-3.5 mr-2" />}
              Sincronizar
            </Button>
          </div>
        </div>

        {/* Período */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground pr-1">Período</span>
          {DATE_PRESETS.filter((p) => ["today", "yesterday", "last_7_days", "last_30_days"].includes(p.key)).map((p) => (
            <Button key={p.key} type="button" size="sm"
              variant={preset === p.key ? "default" : "outline"}
              onClick={() => setPreset(p.key)} className="h-8">
              {p.label}
            </Button>
          ))}
          <span className="text-xs text-muted-foreground ml-2">
            {range.from} → {range.to}
            {preset === "today" && <span className="ml-1 text-warning">(GAM pode estar incompleto)</span>}
          </span>
        </div>

        {/* Conta + Site + View */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Conta Ads</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-9 w-[220px] justify-between gap-2 px-3 font-normal">
                  <span className="truncate">{accountLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[260px]" align="start">
                <DropdownMenuCheckboxItem checked={accountIds.length === 0} onCheckedChange={() => setAccountIds([])}>
                  Todas as contas
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                {visibleAccounts.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma conta disponível.</div>
                )}
                {visibleAccounts.map((a) => (
                  <DropdownMenuCheckboxItem
                    key={a.id}
                    checked={accountIds.includes(a.id)}
                    onCheckedChange={() => toggleAccount(a.id)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="truncate">{a.account_name ?? a.customer_id}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Site</label>
            <Select value={siteId} onValueChange={(v) => { setSiteId(v); setAccountIds([]); }}>
              <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os sites</SelectItem>
                {dash.sites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Visualização</label>
            <div className="inline-flex rounded-md border border-border overflow-hidden text-xs h-9">
              <button
                className={cn("px-3", view === "country" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted")}
                onClick={() => { setView("country"); setExpanded(new Set()); }}>
                Por país
              </button>
              <button
                className={cn("px-3 border-l border-border", view === "campaign" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted")}
                onClick={() => { setView("campaign"); setExpanded(new Set()); }}>
                Por campanha
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Totais */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{sortedCountries.length} países</Badge>
        <Badge variant="outline">{sortedCampaigns.length} campanhas</Badge>
        <Badge variant="outline">Custo: {fmtBRL(totalCost)}</Badge>
        <Badge variant="outline">Receita: {fmtBRL(totalRev)}</Badge>
        <Badge variant={totalProfit >= 0 ? "outline" : "destructive"}>Lucro: {fmtBRL(totalProfit)}</Badge>
        <Badge variant={totalRoi >= 0 ? "outline" : "destructive"}>ROI: {fmtPercent(totalRoi)}</Badge>
      </div>

      {/* Debug */}
      {showDebug && (
        <div className="rounded-xl border border-border bg-muted/20 p-3 text-xs space-y-1">
          <div className="font-semibold mb-1">Debug — distribuição por país</div>
          <div className="text-muted-foreground">Receita = receita campanha × (custo país / custo total da campanha no dia) × {NET_FACTOR} × FX</div>
          <div className="grid grid-cols-6 gap-2 font-mono mt-2 max-h-[300px] overflow-auto">
            <div className="font-semibold">País</div>
            <div className="font-semibold text-right">Custo</div>
            <div className="font-semibold text-right">% custo</div>
            <div className="font-semibold text-right">Receita BRL</div>
            <div className="font-semibold text-right">Cliques</div>
            <div className="font-semibold text-right">Camp.</div>
            {debugTotals.slice(0, 30).map((d) => (
              <Fragment key={d.code}>
                <div>{d.code} {d.name}</div>
                <div className="text-right">{fmtBRL(d.cost)}</div>
                <div className="text-right">{d.sharePct.toFixed(1)}%</div>
                <div className="text-right">{fmtBRL(d.revenue_brl)}</div>
                <div className="text-right">{fmtNumber(d.clicks)}</div>
                <div className="text-right">{d.campaigns.size}</div>
              </Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Tabela */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-10"></TableHead>
              <TableHead>{view === "country" ? "País" : "Campanha"}</TableHead>
              <TableHead className="text-right">{view === "country" ? "Camp." : "Países"}</TableHead>
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
              <TableRow><TableCell colSpan={9} className="text-center py-8">
                <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Carregando...
              </TableCell></TableRow>
            )}
            {!loading && (view === "country" ? sortedCountries.length === 0 : sortedCampaigns.length === 0) && (
              <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                Nenhum dado nesse período. Clique em <b>Sincronizar</b> para puxar do Google Ads.
              </TableCell></TableRow>
            )}

            {!loading && view === "country" && sortedCountries.map((c) => {
              const isOpen = expanded.has(c.code);
              const camps = campaignsByCountry.get(c.code) ?? [];
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
                            <TableHead className="text-right w-32">Ação</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {camps.map((cp) => {
                            const key = `${cp.campaign_id}|${cp.country_criterion_id ?? ""}`;
                            return (
                              <TableRow key={cp.campaign_id}>
                                <TableCell className="text-sm">{cp.name}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(cp.cost)}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(cp.revenue_brl)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums", cp.profit < 0 && "text-danger")}>{fmtBRL(cp.profit)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums font-semibold", cp.roi < 0 ? "text-danger" : "text-success")}>{fmtPercent(cp.roi)}</TableCell>
                                <TableCell className="text-right">
                                  <ExcludeButton
                                    busy={excluding === key}
                                    onConfirm={() => handleExclude(cp.campaign_id, cp.country_criterion_id, c.name)}
                                    label={`Excluir ${c.name} desta campanha`}
                                  />
                                </TableCell>
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

            {!loading && view === "campaign" && sortedCampaigns.map((cp) => {
              const isOpen = expanded.has(cp.campaign_id);
              const list = countriesByCampaign.get(cp.campaign_id) ?? [];
              return (
                <Fragment key={cp.campaign_id}>
                  <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand(cp.campaign_id)}>
                    <TableCell><span className="text-xs">{isOpen ? "▼" : "▶"}</span></TableCell>
                    <TableCell className="font-medium text-sm">{cp.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{cp.countries.size}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(cp.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(cp.revenue_brl)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums font-semibold", cp.profit < 0 ? "text-danger" : "text-success")}>{fmtBRL(cp.profit)}</TableCell>
                    <TableCell className="text-right">
                      <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                        cp.roi >= 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
                        {fmtPercent(cp.roi)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(cp.clicks)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(cp.impressions)}</TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow><TableCell colSpan={9} className="bg-muted/10 p-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>País</TableHead>
                            <TableHead className="text-right">Custo</TableHead>
                            <TableHead className="text-right">Receita</TableHead>
                            <TableHead className="text-right">Lucro</TableHead>
                            <TableHead className="text-right">ROI</TableHead>
                            <TableHead className="text-right w-32">Ação</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {list.map((co) => {
                            const key = `${cp.campaign_id}|${co.country_criterion_id ?? ""}`;
                            return (
                              <TableRow key={co.country_code}>
                                <TableCell className="text-sm">
                                  <span className="font-mono text-xs text-muted-foreground mr-2">{co.country_code}</span>
                                  {co.country_name}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(co.cost)}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(co.revenue_brl)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums", co.profit < 0 && "text-danger")}>{fmtBRL(co.profit)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums font-semibold", co.roi < 0 ? "text-danger" : "text-success")}>{fmtPercent(co.roi)}</TableCell>
                                <TableCell className="text-right">
                                  <ExcludeButton
                                    busy={excluding === key}
                                    onConfirm={() => handleExclude(cp.campaign_id, co.country_criterion_id, co.country_name)}
                                    label={`Excluir ${co.country_name} desta campanha`}
                                  />
                                </TableCell>
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

function ExcludeButton({ busy, onConfirm, label }: { busy: boolean; onConfirm: () => void; label: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger" disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Ban className="h-3.5 w-3.5 mr-1" /> Excluir</>}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Será adicionada uma exclusão de localização (negative geo) na campanha do Google Ads.
            Os anúncios pararão de servir nesse país nessa campanha.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Excluir país</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
