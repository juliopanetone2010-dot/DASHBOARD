import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Globe, ChevronDown, ChevronUp, ChevronsUpDown, Ban, Bug, Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
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
import { GeoCleanupPanel } from "@/components/dashboard/GeoCleanupPanel";
import { GeoExpansionPanel } from "@/components/dashboard/GeoExpansionPanel";
import { computeCountryPerformanceClient, type ClientCountryCell } from "@/lib/countryPerformance";

interface Props { fxUsdBrl: number; }

type SortKey = "cost" | "revenue" | "roi" | "clicks" | "impressions";
type ViewMode = "country" | "campaign";

const normalizeCountryCode = (countryCode: string | null | undefined) => String(countryCode ?? "").trim().toUpperCase();
const countryExclusionKey = (campaignId: string, countryCode: string | null | undefined) => `${campaignId}|country:${normalizeCountryCode(countryCode)}`;
const criterionExclusionKey = (campaignId: string, criterionId: string | null | undefined) => `${campaignId}|criterion:${String(criterionId ?? "").replace(/\D/g, "")}`;
const addCountryExclusionKeys = (set: Set<string>, campaignId: string, countryCode?: string | null, criterionId?: string | null) => {
  const code = normalizeCountryCode(countryCode);
  const criterion = String(criterionId ?? "").replace(/\D/g, "");
  if (code) set.add(countryExclusionKey(campaignId, code));
  if (criterion) set.add(criterionExclusionKey(campaignId, criterion));
};
const isCountryExcluded = (set: Set<string>, campaignId: string, countryCode?: string | null, criterionId?: string | null) => {
  const code = normalizeCountryCode(countryCode);
  const criterion = String(criterionId ?? "").replace(/\D/g, "");
  return (code && set.has(countryExclusionKey(campaignId, code))) || (criterion && set.has(criterionExclusionKey(campaignId, criterion)));
};

export function CountriesTab({ fxUsdBrl }: Props) {
  const dash = useDashboardData();

  const [preset, setPreset] = useState<DatePresetKey>("yesterday");
  const [accountIds, setAccountIds] = useState<string[]>([]); // empty = all
  const [siteId, setSiteId] = useState<string>("all");
  const [view, setView] = useState<ViewMode>("country");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "cost", dir: "desc" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [excluding, setExcluding] = useState<string | null>(null);
  const [excludedKeys, setExcludedKeys] = useState<Set<string>>(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [countryRows, setCountryRows] = useState<ClientCountryCell[]>([]);
  const [engineWarnings, setEngineWarnings] = useState<string[]>([]);
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
      const result = await computeCountryPerformanceClient({
        siteId: siteId === "all" ? null : siteId,
        accountIds: effectiveAccountIds.length > 0 ? effectiveAccountIds : null,
        campaignIds: null,
        from: range.from,
        to: range.to,
        fxUsdBrl,
        netFactor: NET_FACTOR,
      });
      const cells = [...result.cells.values()];
      setCountryRows(cells);
      setEngineWarnings(result.warnings);

      const ids = [...new Set(cells.map((r) => r.campaign_id))];
      const names: Record<string, string> = {};
      for (const c of dash.campaigns) names[c.campaign_id] = c.name;
      for (let i = 0; i < ids.length; i += 200) {
        const { data: campRows } = await supabase
          .from("campaigns")
          .select("campaign_id, name")
          .in("campaign_id", ids.slice(i, i + 200));
        for (const c of campRows ?? []) names[String(c.campaign_id)] = c.name;
      }
      setCampNames(names);

      // Rehidrata exclusões já executadas (persistidas em automation_actions)
      if (ids.length > 0) {
        const excluded = new Set<string>();
        for (let i = 0; i < ids.length; i += 200) {
          const { data: acts } = await supabase
            .from("automation_actions")
            .select("campaign_id, payload")
            .eq("action_type", "exclude_country")
            .eq("status", "executed")
            .in("campaign_id", ids.slice(i, i + 200))
            .limit(5000);
          for (const a of acts ?? []) {
            const payload = (a.payload as any) ?? {};
            addCountryExclusionKeys(excluded, String(a.campaign_id), payload.country_code, payload.country_criterion_id);
          }
        }
        setExcludedKeys(excluded);
      }
    } catch (e) {
      toast({ title: "Erro ao carregar países", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      setCountryRows([]);
      setEngineWarnings([]);
      setCampNames({});
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
      const syncBody = {
        from: range.from,
        to: range.to,
        site_id: siteId === "all" ? undefined : siteId,
        account_ids: effectiveAccountIds,
        revenue_only: true,
        skip_viewability: true,
        skip_snapshot_regen: true,
        include_yesterday_fallback: preset === "today",
      };
      const adsRes = await supabase.functions.invoke<{ ok?: boolean; error?: string }>("google-ads-sync-campaigns", { body: syncBody });
      if (adsRes.error || adsRes.data?.error) {
        toast({ title: "Erro Google Ads", description: adsRes.data?.error ?? adsRes.error?.message, variant: "destructive" });
        return;
      }
      const gamRes = await supabase.functions.invoke<{ ok?: boolean; error?: string }>("gam-sync-revenue", { body: syncBody });
      if (gamRes.error || gamRes.data?.error) {
        toast({ title: "Erro GAM", description: gamRes.data?.error ?? gamRes.error?.message, variant: "destructive" });
        return;
      }
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; rows?: number }>(
        "google-ads-sync-countries",
        { body: { lookback_days: days, from: range.from, to: range.to, site_id: siteId === "all" ? undefined : siteId, account_ids: effectiveAccountIds } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao sincronizar", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      toast({ title: "Sincronização concluída", description: `${data?.rows ?? 0} linhas importadas` });
      await load();
    } finally { setSyncing(false); }
  };

  const { byCountry, byCampaign, countriesByCampaign, campaignsByCountry, debugTotals } = useMemo(() => {
    interface CCAcc {
      campaign_id: string;
      country_code: string;
      country_name: string;
      country_criterion_id: string | null;
      cost: number;
      revenue_brl: number;
      revenue_gross_usd: number;
      clicks: number;
      impressions: number;
      conversions: number;
      share_method: string;
      share_pct: number;
      site_factor_avg: number;
    }
    const cellMap = new Map<string, CCAcc>();
    for (const r of countryRows) cellMap.set(`${r.campaign_id}|${r.country_code}`, {
      campaign_id: r.campaign_id,
      country_code: r.country_code,
      country_name: r.country_name ?? r.country_code,
      country_criterion_id: r.country_criterion_id,
      cost: Number(r.cost_brl) || 0,
      revenue_brl: Number(r.revenue_brl) || 0,
      revenue_gross_usd: Number(r.revenue_gross_usd) || 0,
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
      conversions: Number(r.conversions) || 0,
      share_method: r.share_method,
      share_pct: Number(r.share_pct) || 0,
      site_factor_avg: Number(r.site_factor_avg) || 0,
    });

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
  }, [countryRows, campNames]);

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

  const handleExclude = async (campaignId: string, criterionId: string | null, countryName: string, countryCode: string) => {
    if (!criterionId) {
      toast({ title: "Sem ID do país", description: "Sincronize de novo para obter o ID do critério.", variant: "destructive" });
      return;
    }
    setExcluding(`${campaignId}|${criterionId}`);
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
        "google-ads-mutate",
        { body: { action: "exclude_country", campaign_id: campaignId, country_criterion_id: criterionId, country_code: countryCode } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao excluir país", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      setExcludedKeys((s) => { const n = new Set(s); addCountryExclusionKeys(n, campaignId, countryCode, criterionId); return n; });
      setSelectedKeys((s) => { const n = new Set(s); n.delete(countryExclusionKey(campaignId, countryCode)); return n; });
      toast({ title: "País excluído", description: `${countryName} adicionado como exclusão na campanha.` });
    } finally { setExcluding(null); }
  };

  const handleBulkExclude = async () => {
    const items: { campaignId: string; criterionId: string | null; countryCode: string; countryName: string }[] = [];
    const seen = new Set<string>();
    for (const r of countryRows) {
      const k = countryExclusionKey(r.campaign_id, r.country_code);
      if (selectedKeys.has(k) && !isCountryExcluded(excludedKeys, r.campaign_id, r.country_code, r.country_criterion_id) && !seen.has(k)) {
        seen.add(k);
        items.push({ campaignId: r.campaign_id, criterionId: r.country_criterion_id, countryCode: r.country_code, countryName: r.country_name ?? r.country_code });
      }
    }
    if (items.length === 0) return;
    setBulkBusy(true);
    let ok = 0, fail = 0;
    for (const it of items) {
      if (!it.criterionId) { fail++; continue; }
      try {
        const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
          "google-ads-mutate",
          { body: { action: "exclude_country", campaign_id: it.campaignId, country_criterion_id: it.criterionId, country_code: it.countryCode } },
        );
        if (error || data?.error) { fail++; continue; }
        setExcludedKeys((s) => { const n = new Set(s); addCountryExclusionKeys(n, it.campaignId, it.countryCode, it.criterionId); return n; });
        ok++;
      } catch { fail++; }
    }
    setSelectedKeys(new Set());
    setBulkBusy(false);
    toast({ title: "Exclusão em lote", description: `${ok} excluídos${fail ? `, ${fail} falharam` : ""}.`, variant: fail && !ok ? "destructive" : "default" });
  };

  const [renaming, setRenaming] = useState<string | null>(null);
  const handleRename = async (campaignId: string, newName: string) => {
    setRenaming(campaignId);
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; name?: string }>(
        "google-ads-mutate",
        { body: { action: "set_name", campaign_id: campaignId, name: newName } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao renomear", description: data?.error ?? error?.message, variant: "destructive" });
        return false;
      }
      setCampNames((m) => ({ ...m, [campaignId]: newName }));
      toast({ title: "Campanha renomeada", description: newName });
      return true;
    } finally { setRenaming(null); }
  };



  const toggleSelect = (key: string) => setSelectedKeys((s) => {
    const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n;
  });

  const toggleExpand = (k: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
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
      <GeoCleanupPanel fxUsdBrl={fxUsdBrl} siteId={siteId === "all" ? null : siteId} />
      <GeoExpansionPanel siteId={siteId === "all" ? null : siteId} />
      {/* Header + filtros */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Globe className="h-5 w-5 text-primary" />
          <div className="flex-1 min-w-[260px]">
            <div className="text-sm font-semibold">Performance por país</div>
            <div className="text-xs text-muted-foreground">
              Custo do Google Ads por país. Receita líquida usa a mesma base BRL da dashboard,
              com fator do site e distribuição por impressões (fallback: cliques → conversões → custo).
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

      {selectedKeys.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-2">
          <div className="text-sm">
            <b>{selectedKeys.size}</b> país(es) selecionado(s) para exclusão
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelectedKeys(new Set())} disabled={bulkBusy}>
              Limpar
            </Button>
            <Button size="sm" variant="destructive" onClick={handleBulkExclude} disabled={bulkBusy}>
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <Ban className="h-3.5 w-3.5 mr-2" />}
              Excluir selecionados
            </Button>
          </div>
        </div>
      )}

      {/* Debug */}
      {showDebug && (
        <div className="rounded-xl border border-border bg-muted/20 p-3 text-xs space-y-1">
          <div className="font-semibold mb-1">Debug — distribuição por país</div>
          <div className="text-muted-foreground">Receita = (profit + spend) da dashboard × fator do site × share do país × {NET_FACTOR}</div>
          {engineWarnings.slice(0, 5).map((w) => <div key={w} className="text-warning">{w}</div>)}
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
              const allCamps = campaignsByCountry.get(c.code) ?? [];
              const camps = allCamps.filter((cp) => !isCountryExcluded(excludedKeys, cp.campaign_id, c.code, cp.country_criterion_id));
              if (camps.length === 0) return null;
              const visCost = camps.reduce((a, x) => a + x.cost, 0);
              const visRev = camps.reduce((a, x) => a + x.revenue_brl, 0);
              const visProfit = visRev - visCost;
              const visRoi = visCost > 0 ? (visProfit / visCost) * 100 : 0;
              const visClicks = camps.reduce((a, x) => a + x.clicks, 0);
              const visImpr = camps.reduce((a, x) => a + x.impressions, 0);
              return (
                <Fragment key={c.code}>
                  <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand(c.code)}>
                    <TableCell><span className="text-xs">{isOpen ? "▼" : "▶"}</span></TableCell>
                    <TableCell className="font-medium">
                      <span className="font-mono text-xs text-muted-foreground mr-2">{c.code}</span>
                      {c.name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{camps.length}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(visCost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(visRev)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums font-semibold", visProfit < 0 ? "text-danger" : "text-success")}>{fmtBRL(visProfit)}</TableCell>
                    <TableCell className="text-right">
                      <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                        visRoi >= 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
                        {fmtPercent(visRoi)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(visClicks)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(visImpr)}</TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow><TableCell colSpan={9} className="bg-muted/10 p-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-10"></TableHead>
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
                            const selKey = countryExclusionKey(cp.campaign_id, c.code);
                            return (
                              <TableRow key={cp.campaign_id}>
                                <TableCell onClick={(e) => e.stopPropagation()}>
                                  <input type="checkbox" className="h-4 w-4 cursor-pointer accent-primary"
                                    checked={selectedKeys.has(selKey)}
                                    onChange={() => toggleSelect(selKey)} />
                                </TableCell>
                                <TableCell className="text-sm">{cp.name}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(cp.cost)}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(cp.revenue_brl)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums", cp.profit < 0 && "text-danger")}>{fmtBRL(cp.profit)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums font-semibold", cp.roi < 0 ? "text-danger" : "text-success")}>{fmtPercent(cp.roi)}</TableCell>
                                <TableCell className="text-right">
                                  <div className="inline-flex items-center gap-1">
                                    <RenameButton
                                      busy={renaming === cp.campaign_id}
                                      currentName={cp.name}
                                      onConfirm={(n) => handleRename(cp.campaign_id, n)}
                                    />
                                    <ExcludeButton
                                      busy={excluding === key}
                                      onConfirm={() => handleExclude(cp.campaign_id, cp.country_criterion_id, c.name, c.code)}
                                      label={`Excluir ${c.name} desta campanha`}
                                    />
                                  </div>
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
              const allList = countriesByCampaign.get(cp.campaign_id) ?? [];
              const list = allList.filter((co) => !isCountryExcluded(excludedKeys, cp.campaign_id, co.country_code, co.country_criterion_id));
              if (list.length === 0) return null;
              const visCost = list.reduce((a, x) => a + x.cost, 0);
              const visRev = list.reduce((a, x) => a + x.revenue_brl, 0);
              const visProfit = visRev - visCost;
              const visRoi = visCost > 0 ? (visProfit / visCost) * 100 : 0;
              const visClicks = list.reduce((a, x) => a + x.clicks, 0);
              const visImpr = list.reduce((a, x) => a + x.impressions, 0);
              return (
                <Fragment key={cp.campaign_id}>
                  <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand(cp.campaign_id)}>
                    <TableCell><span className="text-xs">{isOpen ? "▼" : "▶"}</span></TableCell>
                    <TableCell className="font-medium text-sm">
                      <div className="flex items-center gap-2">
                        <span className="truncate">{cp.name}</span>
                        <span onClick={(e) => e.stopPropagation()}>
                          <RenameButton
                            busy={renaming === cp.campaign_id}
                            currentName={cp.name}
                            onConfirm={(n) => handleRename(cp.campaign_id, n)}
                          />
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{list.length}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(visCost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(visRev)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums font-semibold", visProfit < 0 ? "text-danger" : "text-success")}>{fmtBRL(visProfit)}</TableCell>
                    <TableCell className="text-right">
                      <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                        visRoi >= 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
                        {fmtPercent(visRoi)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(visClicks)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(visImpr)}</TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow><TableCell colSpan={9} className="bg-muted/10 p-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-10"></TableHead>
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
                            const selKey = countryExclusionKey(cp.campaign_id, co.country_code);
                            return (
                              <TableRow key={co.country_code}>
                                <TableCell onClick={(e) => e.stopPropagation()}>
                                  <input type="checkbox" className="h-4 w-4 cursor-pointer accent-primary"
                                    checked={selectedKeys.has(selKey)}
                                    onChange={() => toggleSelect(selKey)} />
                                </TableCell>
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
                                    onConfirm={() => handleExclude(cp.campaign_id, co.country_criterion_id, co.country_name, co.country_code)}
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

function RenameButton({ busy, currentName, onConfirm }: { busy: boolean; currentName: string; onConfirm: (newName: string) => Promise<boolean | void> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentName);
  useEffect(() => { if (open) setValue(currentName); }, [open, currentName]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2" disabled={busy} title="Renomear campanha">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renomear campanha</DialogTitle>
          <DialogDescription>
            O nome será atualizado no Google Ads. Útil quando você removeu um país do nome.
          </DialogDescription>
        </DialogHeader>
        <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button
            disabled={busy || !value.trim() || value.trim() === currentName}
            onClick={async () => {
              const ok = await onConfirm(value.trim());
              if (ok !== false) setOpen(false);
            }}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : null}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
