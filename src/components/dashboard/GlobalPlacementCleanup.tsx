import { Fragment, useEffect, useState } from "react";
import { Loader2, Trash2, ShieldAlert, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useDashboardFilters } from "@/contexts/FilterContext";
import { fmtBRL, fmtPercent, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PreviewCampaign {
  campaign_id: string;
  name: string;
  google_account_id: string;
  cost_brl: number;
  revenue_usd: number;
  matched_utm: boolean;
  roi_pct?: number;
}
interface PreviewItem {
  key?: string;
  placement: string;
  type: string;
  app_id?: string | null;
  cost_brl: number;
  revenue_brl: number;
  revenue_usd: number;
  profit_brl: number;
  roi_pct: number;
  clicks: number;
  impressions: number;
  match_utm: boolean;
  reason: string;
  data_ok?: boolean;
  data_warning?: string | null;
  coverage_pct?: number;
  missing_gam_days?: number;
  campaigns: PreviewCampaign[];
}

interface CampaignTotal {
  campaign_id: string; name: string; google_account_id?: string;
  cost_brl: number; revenue_brl: number; profit_brl: number; roi_pct: number;
  bad_count: number; eligible?: boolean;
}
interface AllPlacement {
  key: string;
  campaign_id: string;
  campaign_name: string;
  placement: string;
  type: string;
  clicks: number;
  impressions: number;
  cost_brl: number;
  revenue_usd: number;
  revenue_brl: number;
  roi_pct: number;
  match_kind: "exato" | "root" | "rateio" | "nenhum";
  data_ok: boolean;
  in_bad_list: boolean;
  below_min_cost: boolean;
}
interface PreviewStats {
  eligible: number; total: number; bad?: number; grouped?: number;
  review_only?: number; deletable?: number; unsafe_campaigns?: number;
  skipped_safety?: number; ads_rows?: number; gam_rows?: number;
  with_match?: number; without_match?: number; match_pct?: number;
  gam_total_usd?: number; gam_attributed_usd?: number; gam_attributed_pct?: number;
  period?: { from: string; to: string };
  grand_cost_brl?: number; grand_revenue_brl?: number; grand_profit_brl?: number;
}

interface PreviewResp { ok?: boolean; error?: string; items?: PreviewItem[]; stats?: PreviewStats; campaign_totals?: CampaignTotal[]; all_placements?: AllPlacement[]; }
interface GamSyncResp {
  ok?: boolean;
  error?: string;
  status?: string;
  summary?: Array<Record<string, unknown>>;
  gam_debug?: { rows_returned?: number; error?: string | null };
}

const fmtPlacementRevenue = (usd: number) => {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};

export function GlobalPlacementCleanup({ fxUsdBrl }: { fxUsdBrl: number }) {
  const { filters, range, selectSite } = useDashboardFilters();
  // Permite o usuário sobrescrever o período do dashboard só para a limpeza.
  const [periodOverride, setPeriodOverride] = useState<number | "dashboard">("dashboard");
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const effectiveRange = (() => {
    if (periodOverride === "dashboard") return range;
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    const from = new Date(yesterday.getTime() - (periodOverride - 1) * 86400000);
    return { from: iso(from), to: iso(yesterday) };
  })();
  const analysisWindowDays = Math.max(
    1,
    Math.round((Date.parse(effectiveRange.to) - Date.parse(effectiveRange.from)) / 86400000) + 1,
  );
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [campaignTotals, setCampaignTotals] = useState<CampaignTotal[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<PreviewStats>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDebug, setShowDebug] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [allPlacements, setAllPlacements] = useState<AllPlacement[]>([]);
  const [allSort, setAllSort] = useState<{ col: "cost_brl" | "revenue_usd" | "roi_pct" | "clicks"; dir: "asc" | "desc" }>({ col: "cost_brl", dir: "desc" });
  const [forceDataIncomplete, setForceDataIncomplete] = useState(false);
  const [bulkRoi, setBulkRoi] = useState(-80);
  const [bulkMaxRevUsd, setBulkMaxRevUsd] = useState(0.05);
  const [bulkMinClicks, setBulkMinClicks] = useState(1);
  const [allExpanded, setAllExpanded] = useState<Set<string>>(new Set());
  const [minDays, setMinDays] = useState(7);
  const [maxRoi, setMaxRoi] = useState(-10);
  const [minCost, setMinCost] = useState(20);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [safetyEnabled, setSafetyEnabled] = useState(true);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const itemKey = (i: PreviewItem) => i.key ?? `${i.campaigns[0]?.campaign_id ?? "global"}|${i.placement}`;
  // Tipo suportado pela API de negative placements
  const typeSupported = (i: PreviewItem) => i.type === "WEBSITE" || (i.type === "MOBILE_APPLICATION" && !!i.app_id);
  // Só pode excluir se o tipo é suportado E os dados de receita do período são confiáveis.
  const canExclude = (i: PreviewItem) => typeSupported(i) && i.data_ok !== false;


  // carrega config persistida
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("rules_config")
        .select("placement_auto_cleanup_enabled, placement_cleanup_min_days, placement_cleanup_max_roi_pct, placement_cleanup_min_cost_brl, placement_cleanup_last_run_at")
        .maybeSingle();
      if (data) {
        setAutoEnabled(!!data.placement_auto_cleanup_enabled);
        setMinDays(Number(data.placement_cleanup_min_days ?? 7));
        setMaxRoi(Number(data.placement_cleanup_max_roi_pct ?? -10));
        setMinCost(Number(data.placement_cleanup_min_cost_brl ?? 20));
        setLastRun(data.placement_cleanup_last_run_at ?? null);
      }
      const { data: accs } = await supabase
        .from("google_accounts")
        .select("id, account_name, descriptive_name, customer_id")
        .order("account_name", { ascending: true });
      setAccounts((accs ?? []).map((a: any) => ({ id: a.id, name: a.account_name || a.descriptive_name || a.customer_id })));
      const { data: ss } = await supabase
        .from("sites")
        .select("id, name")
        .order("name", { ascending: true });
      setSites((ss ?? []).map((s: any) => ({ id: s.id, name: s.name })));
    })();
  }, []);

  // Handler para troca de site: carrega contas Ads vinculadas e aplica no contexto global
  const handleSiteChange = async (siteId: string) => {
    if (siteId === "all") {
      selectSite("all", []);
      return;
    }
    const { data: links } = await supabase
      .from("account_site_links")
      .select("google_account_id")
      .eq("site_id", siteId);
    const linked = (links ?? []).map((l: any) => l.google_account_id);
    selectSite(siteId, linked);
  };

  const persistConfig = async (patch: Partial<{
    placement_auto_cleanup_enabled: boolean;
    placement_cleanup_min_days: number;
    placement_cleanup_max_roi_pct: number;
    placement_cleanup_min_cost_brl: number;
  }>) => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase.from("rules_config").update(patch).eq("user_id", u.user.id);
  };

  const toggleAuto = async (on: boolean) => {
    setAutoEnabled(on);
    await persistConfig({
      placement_auto_cleanup_enabled: on,
      placement_cleanup_min_days: minDays,
      placement_cleanup_max_roi_pct: maxRoi,
      placement_cleanup_min_cost_brl: minCost,
    });
    toast({ title: on ? "Limpeza automática ativada (a cada 15 dias)" : "Limpeza automática desativada" });
  };

  const runPreview = async (showAllArg: boolean = showAll) => {
    if (!filters.siteId || filters.siteId === "all") {
      toast({ title: "Selecione um site", description: "A limpeza global precisa de um site para evitar mexer em campanhas de outros sites.", variant: "destructive" });
      return;
    }
    setLoading(true);
    setItems([]);
    setSelected(new Set());
    try {
      const { data, error } = await supabase.functions.invoke<PreviewResp>("placements-cleanup", {
        body: {
          mode: "preview",
          min_days: minDays,
          max_roi_pct: -Math.abs(maxRoi),
          min_cost_brl: minCost,
          lookback_days: analysisWindowDays,
          from: effectiveRange.from,
          to: effectiveRange.to,
          fx_usd_brl: fxUsdBrl,
          site_id: filters.siteId,
          google_account_ids: filters.googleAccountIds,
          show_all: showAllArg,
        },
      });
      if (error || data?.error) {
        toast({ title: "Erro", description: error?.message ?? data?.error, variant: "destructive" });
        return;
      }
      const list = data?.items ?? [];
      setItems(list);
      setCampaignTotals(data?.campaign_totals ?? []);
      setAllPlacements(data?.all_placements ?? []);
      setStats(data?.stats);
      setSelected(new Set(list.filter(canExclude).map(itemKey)));
      setExpanded(new Set());
      setOpen(true);
      // persiste filtros
      await persistConfig({
        placement_cleanup_min_days: minDays,
        placement_cleanup_max_roi_pct: maxRoi,
        placement_cleanup_min_cost_brl: minCost,
      });
    } finally {
      setLoading(false);
    }
  };

  // Liga/desliga a auditoria "todos os placements" — precisa re-consultar porque o
  // backend só devolve all_placements quando show_all=true.
  const toggleShowAll = async (on: boolean) => {
    setShowAll(on);
    if (open) await runPreview(on);
  };

  const [resyncing, setResyncing] = useState(false);
  const runResyncAndPreview = async () => {
    if (!filters.siteId || filters.siteId === "all") {
      toast({ title: "Selecione um site", variant: "destructive" });
      return;
    }
    setResyncing(true);
    try {
      toast({ title: "Ressincronizando receita do GAM…", description: `Aguardando terminar: ${effectiveRange.from} → ${effectiveRange.to}` });
      const { data: gamData, error: gamErr } = await supabase.functions.invoke<GamSyncResp>("gam-sync-revenue", {
        body: {
          wait: true,
          sync: true,
          from: effectiveRange.from,
          to: effectiveRange.to,
          site_id: filters.siteId,
          account_ids: filters.googleAccountIds ?? [],
          revenue_only: true,
          skip_viewability: true,
        },
      });
      if (gamErr || gamData?.error) {
        toast({ title: "Erro no GAM sync", description: gamErr?.message ?? gamData?.error, variant: "destructive" });
        return;
      }
      const googleRows = (gamData?.summary ?? []).reduce((sum, s) => sum + Number(s.google_rows ?? s.rows_returned ?? 0), 0);
      const placementRows = (gamData?.summary ?? []).reduce((sum, s) => sum + Number(s.google_placement_rows ?? 0), 0);
      toast({
        title: "Receita atualizada — rechecando placements…",
        description: `${googleRows} linha(s) de campanha · ${placementRows} linha(s) de placement`,
      });
      await runPreview();
    } finally {
      setResyncing(false);
    }
  };

  const toggle = (k: string) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };
  const matchesAccount = (i: PreviewItem) =>
    accountFilter === "all" || i.campaigns.some((c) => c.google_account_id === accountFilter);
  const toggleAll = (on: boolean) => {
    if (!on) return setSelected(new Set());
    setSelected(new Set(items.filter((i) => canExclude(i) && matchesAccount(i)).map(itemKey)));
  };

  const runApply = async () => {
    if (selected.size === 0) { toast({ title: "Nenhum placement selecionado" }); return; }
    if (!confirm(`Aplicar exclusão (negative placement) em ${selected.size} placement(s)?`)) return;
    setApplying(true);
    try {
      const byKey = new Map<string, any>();
      for (const i of items) {
        if (!selected.has(itemKey(i)) || !matchesAccount(i)) continue;
        const campaigns = i.campaigns
          .filter((c) => accountFilter === "all" || c.google_account_id === accountFilter)
          .map((c) => ({ campaign_id: c.campaign_id, google_account_id: c.google_account_id, cost_brl: c.cost_brl, revenue_usd: c.revenue_usd, roi_pct: i.roi_pct }));
        if (campaigns.length === 0) continue;
        byKey.set(itemKey(i), {
          key: itemKey(i), placement: i.placement, type: i.type, app_id: i.app_id ?? null,
          cost_brl: i.cost_brl, revenue_brl: i.revenue_brl, revenue_usd: i.revenue_usd, roi_pct: i.roi_pct, reason: i.reason,
          campaigns,
        });
      }
      // Seleções feitas na aba "Ver todos" que não estão na lista de "ruins".
      for (const p of allPlacements) {
        if (!selected.has(p.key) || byKey.has(p.key) || p.type !== "WEBSITE") continue;
        const gaid = campaignTotals.find((c) => c.campaign_id === p.campaign_id)?.google_account_id ?? "";
        if (accountFilter !== "all" && gaid !== accountFilter) continue;
        byKey.set(p.key, {
          key: p.key, placement: p.placement, type: "WEBSITE", app_id: null,
          cost_brl: p.cost_brl, revenue_brl: p.revenue_brl, revenue_usd: p.revenue_usd, roi_pct: p.roi_pct,
          reason: p.in_bad_list ? "roi_critico" : "manual",
          campaigns: [{ campaign_id: p.campaign_id, google_account_id: gaid, cost_brl: p.cost_brl, revenue_usd: p.revenue_usd, roi_pct: p.roi_pct }],
        });
      }
      const payload = [...byKey.values()].filter((p) => p.campaigns.length > 0);
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; applied?: number; failed?: number; safety_rejected?: any[] }>(
        "placements-cleanup",
        { body: { mode: "apply", items: payload, fx_usd_brl: fxUsdBrl, site_id: filters.siteId, google_account_ids: filters.googleAccountIds, disable_safety_recheck: !safetyEnabled, force_data_incomplete: forceDataIncomplete } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao aplicar", description: error?.message ?? data?.error, variant: "destructive" });
        return;
      }
      const rejected = data?.safety_rejected ?? [];
      toast({
        title: "Limpeza aplicada",
        description: `${data?.applied ?? 0} excluído(s) · ${data?.failed ?? 0} falha(s)${rejected.length ? ` · 🛡️ ${rejected.length} bloqueado(s) pela trava de segurança (ROI real positivo)` : ""}.`,
      });
      if (rejected.length) {
        console.warn("[safety] placements rejeitados pela re-verificação:", rejected);
      }

      setOpen(false);
    } finally {
      setApplying(false);
    }
  };

  const noMatch = items.filter((i) => !i.match_utm).length;

  // filtra items pela conta selecionada
  const filteredItems = accountFilter === "all"
    ? items
    : items.filter((i) => i.campaigns.some((c) => c.google_account_id === accountFilter));

  // agrupa items por campanha
  const itemsByCampaign = new Map<string, PreviewItem[]>();
  for (const it of filteredItems) {
    for (const c of it.campaigns) {
      if (accountFilter !== "all" && c.google_account_id !== accountFilter) continue;
      const arr = itemsByCampaign.get(c.campaign_id) ?? [];
      arr.push(it);
      itemsByCampaign.set(c.campaign_id, arr);
    }
  }
  // Mostra apenas campanhas que TÊM placements ruins (respeitando ROI máx e custo mín).
  const accountFilteredTotals = accountFilter === "all"
    ? campaignTotals
    : campaignTotals.filter((c) => c.google_account_id === accountFilter);
  const sortedCampaigns = [...accountFilteredTotals]
    .filter((c) => (itemsByCampaign.get(c.campaign_id)?.length ?? 0) > 0)
    .sort((a, b) => a.roi_pct - b.roi_pct);

  // Custo/Lucro do header reflete TODAS campanhas exibidas (com e sem placements ruins),
  // assim bate com o dashboard "Últimos 15 dias".
  const grandCost = sortedCampaigns.reduce((a, c) => a + (c.cost_brl || 0), 0);
  const grandProfit = sortedCampaigns.reduce((a, c) => a + (c.profit_brl || 0), 0);

  const toggleExpand = (cid: string) => {
    setExpanded((s) => { const n = new Set(s); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  };
  // Ordenação da aba "Ver todos"
  const applyAllSort = (col: typeof allSort.col) =>
    setAllSort((s) => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }));
  const sortArrow = (col: typeof allSort.col) => (allSort.col === col ? (allSort.dir === "desc" ? " ↓" : " ↑") : "");
  const sortPls = (arr: AllPlacement[]) =>
    [...arr].sort((a, b) => {
      const d = (a[allSort.col] as number) - (b[allSort.col] as number);
      return allSort.dir === "desc" ? -d : d;
    });
  const warningByCid = (cid: string) =>
    items.find((i) => i.campaigns[0]?.campaign_id === cid && i.data_ok === false)?.data_warning ?? null;
  const toggleAllExpand = (cid: string) =>
    setAllExpanded((s) => { const n = new Set(s); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });
  const toggleAllInCampaign = (cid: string, on: boolean) => {
    const keys = allPlacements.filter((p) => p.campaign_id === cid && p.type === "WEBSITE").map((p) => p.key);
    setSelected((s) => {
      const n = new Set(s);
      for (const k of keys) on ? n.add(k) : n.delete(k);
      return n;
    });
  };
  // "Ver todos": marca de uma vez todo placement WEBSITE que bate os 3 critérios.
  const bulkMatches = (p: AllPlacement) =>
    p.type === "WEBSITE" && p.roi_pct <= bulkRoi && p.revenue_usd <= bulkMaxRevUsd && p.clicks >= bulkMinClicks;
  const bulkSelect = () => {
    const gaidOk = (cid: string) =>
      accountFilter === "all" || (campaignTotals.find((c) => c.campaign_id === cid)?.google_account_id ?? "") === accountFilter;
    const keys = allPlacements.filter((p) => bulkMatches(p) && gaidOk(p.campaign_id)).map((p) => p.key);
    setSelected((s) => new Set([...s, ...keys]));
  };
  // Totais do que está selecionado agora (aba "Ver todos" + lista de ruins).
  const selectionTotals = (() => {
    const seen = new Set<string>();
    let cost = 0, revUsd = 0, n = 0;
    for (const p of allPlacements) {
      if (selected.has(p.key) && !seen.has(p.key)) { seen.add(p.key); cost += p.cost_brl; revUsd += p.revenue_usd; n++; }
    }
    for (const i of items) {
      const k = itemKey(i);
      if (selected.has(k) && !seen.has(k)) { seen.add(k); cost += i.cost_brl; revUsd += i.revenue_usd; n++; }
    }
    return { cost, revUsd, n };
  })();
  const toggleCampaignSelection = (cid: string, on: boolean) => {
    const placements = (itemsByCampaign.get(cid) ?? []).filter(canExclude).map(itemKey);
    setSelected((s) => {
      const n = new Set(s);
      for (const p of placements) on ? n.add(p) : n.delete(p);
      return n;
    });
  };

  return (
    <div className="rounded-xl border border-danger/40 bg-danger/5 p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ShieldAlert className="h-5 w-5 text-danger" />
        <div className="flex-1 min-w-[260px]">
          <div className="text-sm font-semibold">Limpeza global de placements</div>
          <div className="text-xs text-muted-foreground">
            Campanhas <b>ENABLED</b> com ≥ <b>{minDays}d</b>. Marca como ruim cada placement com ROI ≤ {maxRoi}% e custo somado ≥ R$ {minCost} no período selecionado ({analysisWindowDays} dias). Apps/YouTube ficam de fora da exclusão automática.
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/50">
          <Switch checked={autoEnabled} onCheckedChange={toggleAuto} />
          <div className="text-xs">
            <div className="font-medium">Auto cleanup 15d</div>
            <div className="text-muted-foreground text-[10px]">{lastRun ? `último: ${new Date(lastRun).toLocaleString("pt-BR")}` : "nunca executado"}</div>
          </div>
        </div>
        <Button onClick={() => runPreview()} disabled={loading} variant="destructive">
          {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
          Executar limpeza agora
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">
          Site
          <select
            className="h-6 text-xs rounded border border-border bg-background px-2"
            value={filters.siteId || "all"}
            onChange={(e) => handleSiteChange(e.target.value)}
          >
            <option value="all">Todos os sites</option>
            {sites.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
        </label>
        <span className="text-[11px] text-muted-foreground">
          Contas Ads vinculadas: <Badge variant="outline" className="text-[10px]">{filters.googleAccountIds?.length ?? 0}</Badge>
        </span>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Dias mín. <Input type="number" value={minDays} onChange={(e) => setMinDays(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">ROI máx % <Input type="number" value={maxRoi} onChange={(e) => setMaxRoi(+e.target.value)} className="h-6 w-16 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">Custo mín BRL <Input type="number" value={minCost} onChange={(e) => setMinCost(+e.target.value)} className="h-6 w-20 text-xs" /></label>
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">
          Período
          <select
            className="h-6 text-xs rounded border border-border bg-background px-2"
            value={String(periodOverride)}
            onChange={(e) => {
              const v = e.target.value;
              setPeriodOverride(v === "dashboard" ? "dashboard" : Number(v));
            }}
          >
            <option value="dashboard">Dashboard ({Math.max(1, Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1)}d)</option>
            <option value="7">7 dias</option>
            <option value="15">15 dias</option>
            <option value="30">30 dias</option>
            <option value="50">50 dias</option>
          </select>
        </label>
        <span className="text-[11px] text-muted-foreground flex items-center gap-1"><Badge variant="outline" className="text-[10px]">{effectiveRange.from} → {effectiveRange.to} ({analysisWindowDays}d)</Badge></span>
        <label
          className={cn(
            "text-[11px] flex items-center gap-2 px-2 py-1 rounded border",
            safetyEnabled ? "border-success/40 bg-success/5 text-success" : "border-warning/50 bg-warning/10 text-warning",
          )}
          title="Quando ligada, re-confere o ROI real de cada placement no banco antes de bloquear. Desligue só se já validou manualmente e quer forçar a exclusão."
        >
          🛡️ Trava de segurança (ROI real)
          <Switch checked={safetyEnabled} onCheckedChange={setSafetyEnabled} />
        </label>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-7xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Preview · placements ruins</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Período: {stats?.period?.from} → {stats?.period?.to}</Badge>
              <Badge variant="outline">{stats?.eligible}/{stats?.total} campanhas</Badge>
              <Badge variant="outline">{stats?.grouped} placements analisados</Badge>
              <Badge variant="destructive">{items.length} ruins</Badge>
              {noMatch > 0 && <Badge variant="outline" className="border-warning text-warning">{noMatch} sem UTM</Badge>}
              {typeof stats?.match_pct === "number" && (
                <Badge variant="outline" className={cn(stats.match_pct >= 70 ? "border-success text-success" : "border-warning text-warning")}>
                  Match: {stats.match_pct}% ({stats.with_match}/{(stats.with_match ?? 0) + (stats.without_match ?? 0)})
                </Badge>
              )}
              {typeof stats?.gam_attributed_pct === "number" && (
                <Badge variant="outline" title={`GAM total US$ ${stats.gam_total_usd} · atribuído US$ ${stats.gam_attributed_usd}`}>
                  Receita atribuída: {stats.gam_attributed_pct}%
                </Badge>
              )}
              <Badge variant="secondary">Custo ({analysisWindowDays}d): {fmtBRL(grandCost)} · Lucro: {fmtBRL(grandProfit)}</Badge>
              <select
                className="h-7 text-xs rounded border border-border bg-background px-2"
                value={accountFilter}
                onChange={(e) => {
                  const next = e.target.value;
                  setAccountFilter(next);
                  // mantém apenas seleções da conta escolhida
                  setSelected((s) => {
                    if (next === "all") return s;
                    const allowed = new Set(items.filter((i) => i.campaigns.some((c) => c.google_account_id === next)).map(itemKey));
                    return new Set([...s].filter((k) => allowed.has(k)));
                  });
                }}
              >
                <option value="all">Todas as contas ({accounts.length})</option>
                {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
              </select>
              <span className="ml-auto flex items-center gap-3 text-xs">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={runResyncAndPreview}
                  disabled={resyncing || loading}
                  title="Re-puxa receita do GAM no período e roda o preview de novo"
                >
                  {resyncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                  Ressincronizar receita & rechecar
                </Button>
                <span className="flex items-center gap-2">Ver todos <Switch checked={showAll} onCheckedChange={toggleShowAll} /></span>
                <span className="flex items-center gap-2">Debug <Switch checked={showDebug} onCheckedChange={setShowDebug} /></span>
              </span>
            </DialogDescription>
          </DialogHeader>
          {!!stats?.review_only && (
            <div className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              <strong>{stats.review_only} placement(s) bloqueados para exclusão</strong> — {stats.unsafe_campaigns} campanha(s) com receita do Ad Manager incompleta neste período.
              O ROI deles pode estar negativo só por falta de dado. Rode “Ressincronizar receita & rechecar” — se continuar incompleto e você tiver certeza, marque “forçar” no rodapé.
              <ul className="mt-1 list-disc pl-4">
                {[...new Set(
                  items
                    .filter((i) => i.data_ok === false && i.data_warning)
                    .map((i) => `${i.campaigns[0]?.name ?? "campanha"} — ${i.data_warning}${typeof i.coverage_pct === "number" ? ` (cobertura ${i.coverage_pct}%)` : ""}`),
                )].map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
          )}
          {showAll && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px]">
              <span className="font-medium">Marcar em massa:</span>
              <label className="flex items-center gap-1">ROI ≤ <Input type="number" value={bulkRoi} onChange={(e) => setBulkRoi(+e.target.value)} className="h-6 w-16 text-xs" />%</label>
              <label className="flex items-center gap-1">receita ≤ $<Input type="number" step="0.01" value={bulkMaxRevUsd} onChange={(e) => setBulkMaxRevUsd(+e.target.value)} className="h-6 w-16 text-xs" /></label>
              <label className="flex items-center gap-1">cliques ≥ <Input type="number" value={bulkMinClicks} onChange={(e) => setBulkMinClicks(+e.target.value)} className="h-6 w-14 text-xs" /></label>
              <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={bulkSelect}>
                Marcar os que batem ({allPlacements.filter(bulkMatches).length})
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setSelected(new Set())}>Limpar seleção</Button>
              <span className="mx-1 text-border">|</span>
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setAllExpanded(new Set(allPlacements.map((p) => p.campaign_id)))}>Expandir todas</Button>
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setAllExpanded(new Set())}>Recolher todas</Button>
              <span className="ml-auto text-muted-foreground">
                Selecionados: <b>{selectionTotals.n}</b> · custo <b>{fmtBRL(selectionTotals.cost)}</b> · receita <b>{fmtPlacementRevenue(selectionTotals.revUsd)}</b>
              </span>
            </div>
          )}
          {showAll && (
            <div className="overflow-auto flex-1 border border-border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Placement</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => applyAllSort("clicks")}>Cliques{sortArrow("clicks")}</TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => applyAllSort("cost_brl")}>Custo{sortArrow("cost_brl")}</TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => applyAllSort("revenue_usd")}>Receita GAM{sortArrow("revenue_usd")}</TableHead>
                    <TableHead className="text-right cursor-pointer select-none" onClick={() => applyAllSort("roi_pct")}>ROI{sortArrow("roi_pct")}</TableHead>
                    <TableHead>Match</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allPlacements.length === 0 && (
                    <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Sem placements com gasto no período.</TableCell></TableRow>
                  )}
                  {[...new Set(allPlacements.map((p) => p.campaign_id))]
                    .map((cid) => ({ cid, pls: allPlacements.filter((p) => p.campaign_id === cid), ct: campaignTotals.find((c) => c.campaign_id === cid) }))
                    .sort((a, b) => (a.ct?.roi_pct ?? 0) - (b.ct?.roi_pct ?? 0))
                    .map(({ cid, pls, ct }) => {
                      const sumCost = pls.reduce((a, p) => a + p.cost_brl, 0);
                      const sumRevUsd = pls.reduce((a, p) => a + p.revenue_usd, 0);
                      const sumRevBrl = sumRevUsd * 0.935 * fxUsdBrl;
                      const coverage = ct && ct.revenue_brl > 0 ? (sumRevBrl / ct.revenue_brl) * 100 : (sumRevBrl > 0 ? 100 : 0);
                      const warn = warningByCid(cid);
                      const websiteKeys = pls.filter((p) => p.type === "WEBSITE").map((p) => p.key);
                      const allChecked = websiteKeys.length > 0 && websiteKeys.every((k) => selected.has(k));
                      const selCount = pls.reduce((a, p) => a + (selected.has(p.key) ? 1 : 0), 0);
                      const isOpen = allExpanded.has(cid);
                      return (
                        <Fragment key={cid}>
                          <TableRow className="bg-muted/30 cursor-pointer hover:bg-muted/50" onClick={() => toggleAllExpand(cid)}>
                            <TableCell onClick={(e) => e.stopPropagation()}>
                              {websiteKeys.length > 0 && (
                                <Checkbox checked={allChecked} onCheckedChange={(v) => toggleAllInCampaign(cid, !!v)} />
                              )}
                            </TableCell>
                            <TableCell colSpan={7} className="text-xs">
                              <span className="mr-1 text-muted-foreground">{isOpen ? "▼" : "▶"}</span>
                              <span className="font-semibold text-sm">{ct?.name ?? cid}</span>
                              {selCount > 0 && <Badge variant="destructive" className="ml-2 text-[9px]">{selCount} marcado{selCount > 1 ? "s" : ""}</Badge>}
                              <span className="ml-2 text-muted-foreground">
                                {pls.length} placements · Σ custo {fmtBRL(sumCost)} · Σ receita GAM {fmtPlacementRevenue(sumRevUsd)} (≈ {fmtBRL(sumRevBrl)})
                                {ct && ` · campanha: ${fmtBRL(ct.cost_brl)} custo / ${fmtBRL(ct.revenue_brl)} receita`}
                              </span>
                              <span className={cn("ml-2 font-medium", coverage >= 80 ? "text-success" : coverage >= 50 ? "text-warning" : "text-danger")}>
                                cobertura {Math.round(coverage)}%
                              </span>
                              {warn && <div className="text-warning mt-0.5">⚠️ {warn}</div>}
                            </TableCell>
                          </TableRow>
                          {isOpen && sortPls(pls).map((p) => (
                            <TableRow key={p.key} className={cn(p.in_bad_list && "bg-danger/5", !p.data_ok && "bg-warning/5")}>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                {p.type === "WEBSITE" && (
                                  <Checkbox checked={selected.has(p.key)} onCheckedChange={() => toggle(p.key)} />
                                )}
                              </TableCell>
                              <TableCell className="font-mono text-xs max-w-[340px] truncate" title={p.placement}>{p.placement}</TableCell>
                              <TableCell className="text-xs">{p.type}</TableCell>
                              <TableCell className="text-right tabular-nums text-xs">{fmtNumber(p.clicks)}</TableCell>
                              <TableCell className="text-right tabular-nums text-xs">{fmtBRL(p.cost_brl)}</TableCell>
                              <TableCell className="text-right tabular-nums text-xs">{fmtPlacementRevenue(p.revenue_usd)}</TableCell>
                              <TableCell className={cn("text-right tabular-nums text-xs font-semibold", p.roi_pct < 0 ? "text-danger" : "text-success")}>{fmtPercent(p.roi_pct)}</TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={cn("text-[9px]", p.match_kind === "exato" ? "border-success text-success" : p.match_kind === "nenhum" ? "border-warning text-warning" : "")}
                                  title={p.match_kind === "exato" ? "casou utm_placement={campaignid}_{placement} no GAM" : p.match_kind === "root" ? "casou pelo domínio raiz" : p.match_kind === "rateio" ? "sem match exato — receita rateada por custo" : "sem receita GAM atribuída"}
                                >
                                  {p.match_kind}
                                </Badge>
                                {p.in_bad_list && <Badge variant="destructive" className="ml-1 text-[9px]">ruim</Badge>}
                                {p.below_min_cost && <Badge variant="secondary" className="ml-1 text-[9px]">&lt; custo mín</Badge>}
                              </TableCell>
                            </TableRow>
                          ))}
                        </Fragment>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
          )}
          <div className={cn("overflow-auto flex-1 border border-border rounded-lg", showAll && "hidden")}>

            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-10"></TableHead>
                  <TableHead>Campanha</TableHead>
                  <TableHead className="text-right">Custo ({analysisWindowDays}d)</TableHead>
                  <TableHead className="text-right">Receita ({analysisWindowDays}d)</TableHead>
                  <TableHead className="text-right">Lucro</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Ruins</TableHead>
                  <TableHead className="text-right">Selec.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedCampaigns.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Nada a limpar 🎉</TableCell></TableRow>
                )}
                {sortedCampaigns.map((camp) => {
                  const list = itemsByCampaign.get(camp.campaign_id) ?? [];
                  const websiteList = list.filter((i) => i.type === "WEBSITE");
                  const allSelected = websiteList.length > 0 && websiteList.every((i) => selected.has(itemKey(i)));
                  const isOpen = expanded.has(camp.campaign_id);
                  return (
                    <Fragment key={camp.campaign_id}>
                      <TableRow key={camp.campaign_id} className="cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand(camp.campaign_id)}>
                        <TableCell><span className="text-xs">{isOpen ? "▼" : "▶"}</span></TableCell>
                        <TableCell className="font-medium text-sm">{camp.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtBRL(camp.cost_brl)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtBRL(camp.revenue_brl)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", camp.profit_brl < 0 && "text-danger")}>{fmtBRL(camp.profit_brl)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums font-semibold", camp.roi_pct < 0 ? "text-danger" : "text-success")}>{fmtPercent(camp.roi_pct)}</TableCell>
                        <TableCell className="text-right">
                          {list.length > 0
                            ? <Badge variant="destructive">{list.length}</Badge>
                            : <Badge variant="outline" className="border-success/50 text-success">0</Badge>}
                        </TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          {list.length > 0 && (
                            <Checkbox checked={allSelected} onCheckedChange={(v) => toggleCampaignSelection(camp.campaign_id, !!v)} />
                          )}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${camp.campaign_id}-detail`}>
                          <TableCell colSpan={8} className="bg-muted/10 p-0">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead className="w-10"></TableHead>
                                  <TableHead>Placement</TableHead>
                                  <TableHead>Tipo</TableHead>
                                  <TableHead className="text-right">Cliques</TableHead>
                                  <TableHead className="text-right">Custo</TableHead>
                                  <TableHead className="text-right">Receita</TableHead>
                                  <TableHead className="text-right">ROI</TableHead>
                                  {showDebug && <TableHead>Match</TableHead>}
                                  {showDebug && <TableHead>Motivo</TableHead>}
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {list.map((i) => {
                                  const isApp = i.type !== "WEBSITE";
                                  const dataUnsafe = i.data_ok === false;
                                  const disabled = !canExclude(i);
                                  const c = i.campaigns.find((x) => x.campaign_id === camp.campaign_id);
                                  return (
                                    <TableRow key={itemKey(i)} className={cn(disabled && "opacity-60", dataUnsafe && "bg-warning/5")}>
                                      <TableCell>
                                        <Checkbox checked={selected.has(itemKey(i))} disabled={disabled} onCheckedChange={() => toggle(itemKey(i))} />
                                      </TableCell>
                                      <TableCell className="font-mono text-xs max-w-[300px] truncate" title={i.placement}>{i.placement}</TableCell>
                                      <TableCell className="text-xs">
                                        {i.type}
                                        {isApp && !disabled && <Badge variant="outline" className="ml-1 text-[9px]">app id</Badge>}
                                        {dataUnsafe
                                          ? <Badge variant="outline" className="ml-1 text-[9px] border-warning text-warning" title={i.data_warning ?? "Receita GAM incompleta no período"}>dados incompletos</Badge>
                                          : disabled && <Badge variant="secondary" className="ml-1 text-[9px]">manual</Badge>}

                                      </TableCell>
                                      <TableCell className="text-right tabular-nums text-xs">{fmtNumber(i.clicks)}</TableCell>
                                      <TableCell className="text-right tabular-nums text-xs">{fmtBRL(c?.cost_brl ?? 0)}</TableCell>
                                      <TableCell className="text-right tabular-nums text-xs">{fmtPlacementRevenue(c?.revenue_usd ?? 0)}</TableCell>
                                      <TableCell className="text-right tabular-nums text-xs text-danger font-semibold">{fmtPercent(i.roi_pct)}</TableCell>
                                      {showDebug && (
                                        <TableCell>
                                          {c?.matched_utm
                                            ? <Badge variant="outline" className="text-[9px]">true</Badge>
                                            : <Badge variant="outline" className="text-[9px] border-warning text-warning">false</Badge>}
                                        </TableCell>
                                      )}
                                      {showDebug && (
                                        <TableCell className="text-[10px] font-mono max-w-[260px] whitespace-normal">
                                          {i.reason}
                                          {dataUnsafe && i.data_warning && (
                                            <div className="font-sans text-warning mt-0.5">
                                              {i.data_warning}
                                              {typeof i.coverage_pct === "number" && ` · cobertura ${i.coverage_pct}%`}
                                            </div>
                                          )}
                                        </TableCell>
                                      )}
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <DialogFooter className="gap-2 sm:justify-between items-center">
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground" title="Exclui mesmo os placements de campanhas com cobertura GAM baixa. Use só depois de revisar na aba 'Ver todos'.">
              <Checkbox checked={forceDataIncomplete} onCheckedChange={(v) => setForceDataIncomplete(!!v)} />
              Forçar exclusão mesmo com dados incompletos
            </label>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button variant="destructive" disabled={applying || selected.size === 0} onClick={runApply}>
                {applying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
                Aplicar exclusão ({selected.size})
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
