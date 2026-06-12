import { useEffect, useMemo, useState } from "react";
import { Pause, Play, TrendingUp, ChevronDown, ChevronUp, ChevronsUpDown, Loader2, ShieldX, ExternalLink, Copy, RotateCcw, Columns3, AlertTriangle, CheckCircle2, XCircle, ArrowUp, ArrowDown, Minus, Activity, Pencil } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fmtCurrency, fmtUSD, fmtPercent, fmtNumber } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { CampaignAggregate } from "@/types/domain";
import { RestartCampaignButton, RestartStatusBadge, useRestartFlows } from "./RestartCampaignButton";
import { AttachHtml5Button } from "./AttachHtml5Button";
import { CampaignHistoryButton } from "./CampaignHistoryButton";
import { calculateCampaignEcpm } from "@/lib/campaignEcpm";

type SortKey = "spend" | "revenue" | "profit" | "roi" | "roas" | "ecpm" | "clicks" | "conversions" | "ctr" | "convRate" | "cpa" | "impressions" | "age" | "trend" | "score";
type SortDir = "desc" | "asc";
type TrendPeriod = "today" | "yesterday" | "7d" | "15d" | "30d";
const TREND_PERIODS: Array<{ key: TrendPeriod; label: string; days: number }> = [
  { key: "today", label: "Hoje vs Ontem", days: 1 },
  { key: "yesterday", label: "Ontem vs Anteontem", days: 1 },
  { key: "7d", label: "7d vs 7d ant.", days: 7 },
  { key: "15d", label: "15d vs 15d ant.", days: 15 },
  { key: "30d", label: "30d vs 30d ant.", days: 30 },
];

type PendingPauseAction = {
  id: string;
  campaign_id: string;
  action_type: string;
  reason: string | null;
  payload: Record<string, any> | null;
  status: string;
  created_at: string;
};

interface Props {
  campaigns: CampaignAggregate[];
  campaignGamMetrics?: Map<string, { ecpm: number; impressions: number; revenueUsd?: number }>;
  campaignMatchRates?: Map<string, { matchRate: number; impressions: number; totalRequests: number }>;
  downAccountIds?: Set<string>;
  onPause?: (campaignId: string) => void;
  onBoost?: (campaignId: string) => void;
  onRefresh?: () => Promise<void> | void;
}

export function CampaignsTable({ campaigns, campaignGamMetrics, campaignMatchRates, downAccountIds, onPause, onBoost, onRefresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const restartFlows = useRestartFlows();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBudget, setBulkBudget] = useState<number>(40);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Padrão: ROI DESC. null = sem ordenação (ordem original)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>({ key: "roi", dir: "desc" });
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriod>("7d");

  // ===== Customização de colunas (persistido em localStorage) =====
  type ColKey = "score" | "startDate" | "age" | "lastAction" | "spend" | "revenue" | "profit" | "roi" | "trend" | "roas" | "ecpm" | "matchRate" | "impressions" | "clicks" | "ctr" | "conversions" | "convRate" | "cpa";
  const ALL_COLUMNS: Array<{ key: ColKey; label: string }> = [
    { key: "score", label: "Saúde" },
    { key: "startDate", label: "Início gasto" },
    { key: "age", label: "Idade" },
    { key: "lastAction", label: "Última ação" },
    { key: "spend", label: "Gasto" },
    { key: "revenue", label: "Receita" },
    { key: "profit", label: "Lucro" },
    { key: "roi", label: "ROI" },
    { key: "trend", label: "Tendência" },
    { key: "roas", label: "ROAS" },
    { key: "ecpm", label: "eCPM" },
    { key: "matchRate", label: "Taxa Corresp." },
    { key: "impressions", label: "Impr." },
    { key: "clicks", label: "Cliques" },
    { key: "ctr", label: "CTR" },
    { key: "conversions", label: "Conv." },
    { key: "convRate", label: "Tx. Conv." },
    { key: "cpa", label: "CPA" },
  ];
  const STORAGE_KEY = "campaigns-table-visible-cols-v4";
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
      if (raw) return new Set(JSON.parse(raw) as ColKey[]);
    } catch { /* ignore */ }
    return new Set(ALL_COLUMNS.map((c) => c.key));
  });
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(visibleCols))); } catch { /* ignore */ }
  }, [visibleCols]);
  const isVisible = (k: ColKey) => visibleCols.has(k);
  const toggleCol = (k: ColKey) => setVisibleCols((cur) => {
    const next = new Set(cur);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // Final URLs por campaign_id — fonte: campo final_urls do Google Ads API (tabela campaign_final_urls).
  const campaignIds = useMemo(() => campaigns.map((c) => c.campaign_id), [campaigns]);
  const finalUrlsQuery = useQuery({
    queryKey: ["campaign-final-urls", campaignIds.join("|")],
    queryFn: async () => {
      if (campaignIds.length === 0) return new Map<string, string>();
      const { data } = await supabase
        .from("campaign_final_urls")
        .select("campaign_id, final_url, ad_status")
        .in("campaign_id", campaignIds)
        .not("final_url", "is", null);
      const map = new Map<string, string>();
      for (const r of (data ?? []) as Array<{ campaign_id: string; final_url: string | null; ad_status: string | null }>) {
        if (!r.final_url) continue;
        // Prioriza ads ENABLED; primeiro URL vence se ainda não há entrada
        const cur = map.get(r.campaign_id);
        if (!cur) map.set(r.campaign_id, r.final_url);
        else if ((r.ad_status ?? "").toUpperCase() === "ENABLED") map.set(r.campaign_id, r.final_url);
      }
      return map;
    },
    staleTime: 60_000,
    enabled: campaignIds.length > 0,
  });

  // Data de início REAL da campanha (campaign.start_date no Google Ads).
  // Fallback para o primeiro dia com spend > 0 caso o sync ainda não tenha gravado.
  const firstSpendQuery = useQuery({
    queryKey: ["campaign-start-date", campaignIds.join("|")],
    queryFn: async () => {
      if (campaignIds.length === 0) return new Map<string, string>();
      const map = new Map<string, string>();

      // 1) start_date oficial do Ads
      const { data: camps } = await supabase
        .from("campaigns")
        .select("campaign_id, start_date")
        .in("campaign_id", campaignIds);
      for (const r of (camps ?? []) as Array<{ campaign_id: string; start_date: string | null }>) {
        if (r.start_date) map.set(r.campaign_id, r.start_date);
      }

      // 2) fallback: primeiro dia com spend > 0 para campanhas sem start_date
      const missing = campaignIds.filter((id) => !map.has(id));
      if (missing.length > 0) {
        const { data } = await supabase
          .from("daily_metrics")
          .select("campaign_id, date")
          .in("campaign_id", missing)
          .gt("spend", 0)
          .order("date", { ascending: true })
          .limit(50000);
        for (const r of (data ?? []) as Array<{ campaign_id: string; date: string }>) {
          if (!map.has(r.campaign_id)) map.set(r.campaign_id, r.date);
        }
      }
      return map;
    },
    staleTime: 5 * 60_000,
    enabled: campaignIds.length > 0,
  });

  // Última ação consolidada (automação + restart) por campanha
  const lastActionQuery = useQuery({
    queryKey: ["campaign-last-action", campaignIds.join("|")],
    queryFn: async () => {
      if (campaignIds.length === 0) return new Map<string, { date: string; label: string }>();
      const [autom, restart] = await Promise.all([
        supabase
          .from("campaign_automation")
          .select("campaign_id, last_action, last_action_date, last_cpa_action, last_cpa_action_date, last_scale_date")
          .in("campaign_id", campaignIds),
        supabase
          .from("campaign_restart_flow")
          .select("campaign_id, last_action, last_action_at")
          .in("campaign_id", campaignIds),
      ]);
      const out = new Map<string, { date: string; label: string }>();
      const consider = (cid: string, date: string | null | undefined, label: string) => {
        if (!cid || !date) return;
        const cur = out.get(cid);
        if (!cur || String(date) > cur.date) out.set(cid, { date: String(date), label });
      };
      for (const r of (autom.data ?? []) as any[]) {
        consider(r.campaign_id, r.last_action_date, r.last_action ?? "automação");
        consider(r.campaign_id, r.last_cpa_action_date, r.last_cpa_action ?? "cpa");
        consider(r.campaign_id, r.last_scale_date, "scale");
      }
      for (const r of (restart.data ?? []) as any[]) {
        consider(r.campaign_id, r.last_action_at, r.last_action ?? "reinício");
      }
      return out;
    },
    staleTime: 60_000,
    enabled: campaignIds.length > 0,
  });

  const pendingPauseQuery = useQuery({
    queryKey: ["pending-pause-approvals"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("automation_actions")
        .select("id, campaign_id, action_type, reason, payload, status, created_at")
        .eq("status", "pending")
        .eq("action_type", "auto_pause_review")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as PendingPauseAction[];
    },
    refetchInterval: 30_000,
  });

  // === Tendência ROI: atual vs período anterior ===
  type TrendData = { currentRoi: number; prevRoi: number; diff: number; currentSpend: number; prevSpend: number };
  const trendQuery = useQuery({
    queryKey: ["campaign-trend", trendPeriod, campaignIds.join("|")],
    queryFn: async () => {
      const out = new Map<string, TrendData>();
      if (campaignIds.length === 0) return out;
      const periodCfg = TREND_PERIODS.find((p) => p.key === trendPeriod)!;
      const totalDays = periodCfg.days * 2;
      const offsetDays = trendPeriod === "yesterday" ? 1 : 0;
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const endDate = new Date(today.getTime() - offsetDays * 86400000);
      const startDate = new Date(endDate.getTime() - (totalDays - 1) * 86400000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const { data } = await supabase
        .from("daily_metrics")
        .select("campaign_id, date, spend, revenue")
        .in("campaign_id", campaignIds)
        .gte("date", fmt(startDate))
        .lte("date", fmt(endDate))
        .limit(50000);
      const midDate = new Date(endDate.getTime() - (periodCfg.days - 1) * 86400000);
      const midStr = fmt(midDate);
      const agg = new Map<string, { curS: number; curR: number; prvS: number; prvR: number }>();
      for (const r of (data ?? []) as Array<{ campaign_id: string; date: string; spend: number; revenue: number }>) {
        const cur = agg.get(r.campaign_id) ?? { curS: 0, curR: 0, prvS: 0, prvR: 0 };
        const isCurrent = r.date >= midStr;
        if (isCurrent) { cur.curS += Number(r.spend) || 0; cur.curR += Number(r.revenue) || 0; }
        else { cur.prvS += Number(r.spend) || 0; cur.prvR += Number(r.revenue) || 0; }
        agg.set(r.campaign_id, cur);
      }
      for (const [cid, a] of agg) {
        const currentRoi = a.curS > 0 ? ((a.curR - a.curS) / a.curS) * 100 : 0;
        const prevRoi = a.prvS > 0 ? ((a.prvR - a.prvS) / a.prvS) * 100 : 0;
        out.set(cid, { currentRoi, prevRoi, diff: currentRoi - prevRoi, currentSpend: a.curS, prevSpend: a.prvS });
      }
      return out;
    },
    staleTime: 60_000,
    enabled: campaignIds.length > 0,
  });

  // Health score: 🟢 saudável, 🟡 atenção, 🔴 crítico
  const computeScore = (c: CampaignAggregate, d: { ctr: number; convRate: number; cpa: number } | undefined, trend?: TrendData) => {
    const roi = Number(c.roi) || 0;
    const ctr = d?.ctr ?? 0;
    let neg = 0; let warn = 0;
    if (roi < 0) neg++;
    else if (roi < 15) warn++;
    if (ctr > 0 && ctr < 0.3) warn++;
    if (trend && trend.diff < -20) neg++;
    else if (trend && trend.diff < -5) warn++;
    if (c.spend > 0 && c.conversions === 0) warn++;
    if (neg > 0) return { level: "critical" as const, color: "bg-danger", label: "Crítico", emoji: "🔴" };
    if (warn >= 2) return { level: "warning" as const, color: "bg-warning", label: "Atenção", emoji: "🟡" };
    return { level: "healthy" as const, color: "bg-success", label: "Saudável", emoji: "🟢" };
  };


  const ageInDays = (iso: string | undefined): number | null => {
    if (!iso) return null;
    const start = new Date(iso + "T00:00:00Z").getTime();
    const today = Date.now();
    return Math.max(0, Math.floor((today - start) / 86400000));
  };



  // Métricas derivadas dos agregados (clicks/impressions/conversions/cost vêm DIRETO do Ads API).
  // Fórmulas oficiais (mesmo cálculo que o Ads UI faz ao agregar dias):
  //   CTR = clicks / impressions
  //   Tx. Conv. = conversions / clicks
  //   CPA = cost / conversions
  const derived = useMemo(() => {
    const m = new Map<string, { ctr: number; convRate: number; cpa: number }>();
    for (const c of campaigns) {
      const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
      const convRate = c.clicks > 0 ? (c.conversions / c.clicks) * 100 : 0;
      const cpa = c.conversions > 0 ? c.spend / c.conversions : 0;
      m.set(c.campaign_id, { ctr, convRate, cpa });
    }
    return m;
  }, [campaigns]);

  const handleSort = (key: SortKey) => {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: "desc" };
      if (cur.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  };

  const sortedCampaigns = useMemo(() => {
    if (!sort) return campaigns;
    const arr = [...campaigns];
    const mult = sort.dir === "desc" ? -1 : 1;
    const valueOf = (c: CampaignAggregate): number => {
      const d = derived.get(c.campaign_id);
      switch (sort.key) {
        case "ctr": return d?.ctr ?? 0;
        case "convRate": return d?.convRate ?? 0;
        case "cpa": return d?.cpa ?? 0;
        case "ecpm": return campaignGamMetrics?.get(c.campaign_id)?.ecpm ?? Number(c.ecpm ?? 0);
        case "impressions": return campaignGamMetrics?.get(c.campaign_id)?.impressions ?? Number(c.impressions ?? 0);
        case "age": return ageInDays(firstSpendQuery.data?.get(c.campaign_id)) ?? -1;
        case "trend": return trendQuery.data?.get(c.campaign_id)?.diff ?? 0;
        case "score": {
          const t = trendQuery.data?.get(c.campaign_id);
          const s = computeScore(c, d, t);
          return s.level === "healthy" ? 2 : s.level === "warning" ? 1 : 0;
        }
        default: return Number((c as any)[sort.key] ?? 0);
      }
    };
    arr.sort((a, b) => {
      const av = valueOf(a), bv = valueOf(b);
      if (av === bv) return 0;
      return av < bv ? -1 * mult : 1 * mult;
    });
    return arr;
  }, [campaigns, sort, derived, campaignGamMetrics, firstSpendQuery.data, trendQuery.data]);

  const copyToClipboard = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "URL copiada", description: url });
    } catch {
      toast({ title: "Erro ao copiar", variant: "destructive" });
    }
  };

  const shortenUrl = (url: string): string => {
    try {
      const u = new URL(url);
      const path = u.pathname.length > 22 ? u.pathname.slice(0, 22) + "…" : u.pathname;
      return `${u.hostname.replace(/^www\./, "")}${path}`;
    } catch {
      return url.length > 32 ? url.slice(0, 32) + "…" : url;
    }
  };

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (!sort || sort.key !== k) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
    return sort.dir === "desc"
      ? <ChevronDown className="h-3 w-3" />
      : <ChevronUp className="h-3 w-3" />;
  };

  const SortHead = ({ k, label, className }: { k: SortKey; label: string; className?: string }) => {
    const active = sort?.key === k;
    return (
      <TableHead className={cn("text-right whitespace-nowrap", active && "bg-primary/5", className)}>
        <button
          type="button"
          onClick={() => handleSort(k)}
          className={cn(
            "inline-flex items-center gap-1 ml-auto select-none hover:text-foreground transition-colors",
            active ? "text-foreground font-semibold" : "text-muted-foreground",
          )}
        >
          {label}
          <SortIcon k={k} />
        </button>
      </TableHead>
    );
  };

  const callMutate = async (label: string, body: Record<string, unknown>, key: string) => {
    setBusy(key);
    const { data, error } = await supabase.functions.invoke<{
      ok?: boolean; error?: string; ad_groups_updated?: number; new_status?: string;
      budget_from?: number; budget_to?: number;
    }>("google-ads-mutate", { body });
    setBusy(null);
    if (error || data?.error) {
      toast({
        title: `Erro: ${label}`,
        description: data?.error ?? error?.message ?? "Falha desconhecida",
        variant: "destructive",
      });
      return;
    }
    let description = `${data?.ad_groups_updated ?? 0} ad group(s) atualizados`;
    if (data?.new_status) description = `Status alterado para ${data.new_status}`;
    else if (data?.budget_to != null) description = `Orçamento: ${data.budget_from?.toFixed(2)} → ${data.budget_to.toFixed(2)}`;
    toast({ title: label, description });
    await onRefresh?.();
  };

  const toggleOne = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((cur) => {
      if (cur.size === sortedCampaigns.length) return new Set();
      return new Set(sortedCampaigns.map((c) => c.campaign_id));
    });
  };
  const clearSelection = () => setSelected(new Set());

  const bulkRestart = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Reiniciar ${selected.size} campanha(s) com R$ ${bulkBudget}/dia?`)) return;
    setBulkBusy(true);
    const idToCamp = new Map(campaigns.map((c) => [c.campaign_id, c]));
    let ok = 0; let fail = 0;
    for (const id of selected) {
      const c = idToCamp.get(id);
      try {
        const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>("campaign-restart", {
          body: { action: "init", campaign_id: id, google_account_id: (c as any)?.google_account_id ?? null, budget_brl: bulkBudget },
        });
        if (error || data?.error) fail++; else ok++;
      } catch { fail++; }
    }
    setBulkBusy(false);
    toast({ title: "Reinício em lote", description: `${ok} ok · ${fail} falha(s)`, variant: fail > 0 ? "destructive" : undefined });
    clearSelection();
    restartFlows.refetch();
    await onRefresh?.();
  };

  const decidePauseApproval = async (action: PendingPauseAction, approved: boolean) => {
    const key = `approval:${action.id}`;
    setBusy(key);
    try {
      if (!approved) {
        const { error } = await supabase
          .from("automation_actions")
          .update({ status: "rejected", executed_at: new Date().toISOString() })
          .eq("id", action.id);
        if (error) throw error;
        toast({ title: "Pausa recusada", description: "A campanha continua ativa." });
      } else {
        const camp = campaigns.find((c) => c.campaign_id === action.campaign_id);
        const payload = action.payload ?? {};
        const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>("google-ads-mutate", {
          body: {
            action: "set_status",
            campaign_id: action.campaign_id,
            status: "PAUSED",
            google_account_id: payload.google_account_id ?? (camp as any)?.google_account_id ?? null,
            site_id: payload.site_id ?? null,
          },
        });
        if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Falha ao pausar");
        const { error: updErr } = await supabase
          .from("automation_actions")
          .update({ status: "executed", executed_at: new Date().toISOString() })
          .eq("id", action.id);
        if (updErr) throw updErr;
        toast({ title: "Pausa aprovada", description: camp?.name ?? action.campaign_id });
      }
      await pendingPauseQuery.refetch();
      await onRefresh?.();
    } catch (e: any) {
      toast({ title: approved ? "Erro ao aprovar pausa" : "Erro ao recusar pausa", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const pendingPauseActions = pendingPauseQuery.data ?? [];
  const campaignNameById = new Map(campaigns.map((c) => [c.campaign_id, c.name]));

  useEffect(() => {
    if (pendingPauseActions.length > 0) setReviewOpen(true);
  }, [pendingPauseActions.length]);

  return (
    <TooltipProvider delayDuration={150}>
    <div className="rounded-xl border border-border bg-card shadow-elegant overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          {selected.size > 0 && (
            <>
              <span className="font-semibold">{selected.size} selecionada(s)</span>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Orçamento R$/dia:</span>
                <Input
                  type="number"
                  min={1}
                  value={bulkBudget}
                  onChange={(e) => setBulkBudget(Math.max(1, Number(e.target.value) || 40))}
                  className="h-7 w-20 text-xs"
                />
              </div>
              <Button size="sm" className="h-7 gap-1" disabled={bulkBusy} onClick={bulkRestart}>
                {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Reiniciar selecionadas
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={clearSelection}>Limpar</Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            <span>Tendência:</span>
            <select
              value={trendPeriod}
              onChange={(e) => setTrendPeriod(e.target.value as TrendPeriod)}
              className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
            >
              {TREND_PERIODS.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant={pendingPauseActions.length > 0 ? "default" : "outline"}
            className="h-7 gap-1.5 text-xs"
            onClick={() => setReviewOpen(true)}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Revisar pausas ({pendingPauseActions.length})
          </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs">
              <Columns3 className="h-3.5 w-3.5" />
              Colunas ({visibleCols.size}/{ALL_COLUMNS.length})
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-2">
            <div className="flex items-center justify-between px-1 pb-2">
              <span className="text-xs font-semibold">Personalizar colunas</span>
              <button
                type="button"
                className="text-[10px] text-primary hover:underline"
                onClick={() => setVisibleCols(new Set(ALL_COLUMNS.map((c) => c.key)))}
              >
                Mostrar todas
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {ALL_COLUMNS.map((c) => (
                <label
                  key={c.key}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted cursor-pointer"
                >
                  <Checkbox checked={isVisible(c.key)} onCheckedChange={() => toggleCol(c.key)} />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        </div>
      </div>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Aprovar pausas automáticas
            </DialogTitle>
            <DialogDescription>
              Nenhuma campanha será desativada automaticamente sem sua aprovação aqui.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border">
            {pendingPauseActions.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">Nenhuma pausa pendente de aprovação.</div>
            ) : (
              <Table className="text-xs">
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableHead>Campanha</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead className="text-right">Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingPauseActions.map((a) => {
                    const name = campaignNameById.get(a.campaign_id) ?? String(a.payload?.name ?? a.campaign_id);
                    const rowBusy = busy === `approval:${a.id}`;
                    return (
                      <TableRow key={a.id}>
                        <TableCell className="align-top">
                          <div className="font-semibold whitespace-normal break-words">{name}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{a.campaign_id}</div>
                        </TableCell>
                        <TableCell className="align-top text-muted-foreground whitespace-normal break-words">
                          {a.reason ?? "Pausa sugerida pela automação"}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" className="h-8 gap-1" disabled={rowBusy} onClick={() => decidePauseApproval(a, false)}>
                              <XCircle className="h-3.5 w-3.5" /> Não pausar
                            </Button>
                            <Button size="sm" className="h-8 gap-1" disabled={rowBusy} onClick={() => decidePauseApproval(a, true)}>
                              {rowBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                              Pausar
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReviewOpen(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="overflow-x-auto [transform:rotateX(180deg)]">
        <Table className="min-w-[1200px] text-xs [transform:rotateX(180deg)] [&_td]:px-2 [&_td]:py-2 [&_th]:h-9 [&_th]:px-2">
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="sticky left-0 z-30 w-[40px] min-w-[40px] bg-muted/95 border-r border-border shadow-sm">
                <Checkbox
                  checked={sortedCampaigns.length > 0 && selected.size === sortedCampaigns.length}
                  onCheckedChange={toggleAll}
                  aria-label="Selecionar todas"
                />
              </TableHead>
              <TableHead className="sticky left-[40px] z-30 w-[132px] min-w-[132px] bg-muted/95 border-r border-border shadow-sm">Campaign ID</TableHead>
              <TableHead className="sticky left-[172px] z-30 w-[420px] min-w-[420px] bg-muted/95 border-r border-border shadow-sm">Nome</TableHead>
              <TableHead className="sticky left-[592px] z-30 w-[300px] min-w-[300px] bg-muted/95 border-r border-border shadow-sm">Final URL</TableHead>
              {isVisible("score") && <SortHead k="score" label="Saúde" />}
              {isVisible("startDate") && <TableHead className="w-[100px] text-xs">Início gasto</TableHead>}
              {isVisible("age") && <SortHead k="age" label="Idade" />}
              {isVisible("lastAction") && <TableHead className="w-[140px] text-xs">Última ação</TableHead>}
              {isVisible("spend") && <SortHead k="spend" label="Gasto" />}
              {isVisible("revenue") && <SortHead k="revenue" label="Receita" />}
              {isVisible("profit") && <SortHead k="profit" label="Lucro" />}
              {isVisible("roi") && <SortHead k="roi" label="ROI" />}
              {isVisible("trend") && <SortHead k="trend" label="Tendência" />}
              {isVisible("roas") && <SortHead k="roas" label="ROAS" />}
              {isVisible("ecpm") && <SortHead k="ecpm" label="eCPM" />}
              {isVisible("matchRate") && <TableHead className="text-right text-xs">Taxa Corresp.</TableHead>}
              {isVisible("impressions") && <SortHead k="impressions" label="Impr." />}
              {isVisible("clicks") && <SortHead k="clicks" label="Cliques" />}
              {isVisible("ctr") && <SortHead k="ctr" label="CTR" />}
              {isVisible("conversions") && <SortHead k="conversions" label="Conv." />}
              {isVisible("convRate") && <SortHead k="convRate" label="Tx. Conv." />}
              {isVisible("cpa") && <SortHead k="cpa" label="CPA" />}
              
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedCampaigns.length === 0 && (
              <TableRow>
                <TableCell colSpan={5 + visibleCols.size} className="text-center text-muted-foreground py-10">
                  Nenhuma campanha com dados. Conecte uma conta Google Ads na aba "Integrações".
                </TableCell>
              </TableRow>
            )}
            {sortedCampaigns.map((c) => {
              const positive = c.profit >= 0;
              const isPaused = c.status === "paused";
              const accountDown = !!(c.google_account_id && downAccountIds?.has(c.google_account_id));
              const rowKey = c.campaign_id;
              const loading = busy === rowKey;
              const finalUrl = finalUrlsQuery.data?.get(c.campaign_id);
              const d = derived.get(c.campaign_id);
              const gamMetric = campaignGamMetrics?.get(c.campaign_id);
              const gamEcpm = gamMetric?.ecpm ?? (Number(c.ecpm) || 0);
              const firstSpend = firstSpendQuery.data?.get(c.campaign_id);
              const age = ageInDays(firstSpend);
              const lastAction = lastActionQuery.data?.get(c.campaign_id);
              const ecpmDebug = calculateCampaignEcpm(gamMetric?.revenueUsd ?? 0, gamMetric?.impressions ?? 0);
              const trend = trendQuery.data?.get(c.campaign_id);
              const score = computeScore(c, d, trend);
              return (
                <TableRow key={c.campaign_id} className={cn("group", accountDown && "bg-danger-soft/20", selected.has(c.campaign_id) && "bg-primary/5")}>
                  <TableCell className="sticky left-0 z-20 w-[40px] min-w-[40px] bg-card border-r border-border shadow-sm">
                    <Checkbox
                      checked={selected.has(c.campaign_id)}
                      onCheckedChange={() => toggleOne(c.campaign_id)}
                      aria-label={`Selecionar ${c.name}`}
                    />
                  </TableCell>
                  <TableCell className="sticky left-[40px] z-20 w-[132px] min-w-[132px] bg-card border-r border-border font-mono text-[11px] text-muted-foreground shadow-sm">
                    {c.campaign_id}
                  </TableCell>
                  <TableCell className="sticky left-[172px] z-20 w-[420px] min-w-[420px] bg-card border-r border-border font-medium shadow-sm">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 whitespace-normal">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className={cn("h-2.5 w-2.5 rounded-full shrink-0 cursor-help", score.color)} aria-label={score.label} />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            {score.emoji} <b>{score.label}</b><br />
                            ROI: {fmtPercent(c.roi)} • CTR: {(d?.ctr ?? 0).toFixed(2)}%
                            {trend && <> • Tendência: {trend.diff >= 0 ? "+" : ""}{trend.diff.toFixed(1)}pp</>}
                          </TooltipContent>
                        </Tooltip>
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          accountDown ? "bg-danger" :
                          c.status === "enabled" ? "bg-success" : isPaused ? "bg-warning" : "bg-muted-foreground"
                        )} />
                        <span className={cn("min-w-0 flex-1 break-words leading-snug", accountDown && "text-danger")}>{c.name}</span>
                        {accountDown && (
                          <Badge variant="destructive" className="text-[10px] gap-1">
                            <ShieldX className="h-3 w-3" /> Conta suspensa
                          </Badge>
                        )}
                        <RestartStatusBadge flow={restartFlows.data?.get(c.campaign_id)} />
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className={cn(
                                "h-7 px-2",
                                isPaused ? "text-success hover:text-success" : "text-warning hover:text-warning",
                              )}
                              title={isPaused ? "Ativar campanha" : "Pausar campanha"}
                              onClick={() => callMutate(
                                isPaused ? "Campanha ativada" : "Campanha pausada",
                                { action: "set_status", campaign_id: c.campaign_id, status: isPaused ? "ENABLED" : "PAUSED" },
                                rowKey,
                              )}
                            >
                              {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                            </Button>
                            <InlineMoneyEdit
                              label="CPA"
                              title={`Target CPA (ad groups) – ${c.name}`}
                              value={((c as any)?.target_cpa_micros ?? 0) / 1_000_000}
                              disabled={loading}
                              onSave={(v) => callMutate(
                                `Target CPA (ad groups) = ${v.toFixed(2)}`,
                                { action: "set_ad_group_cpa_absolute", campaign_id: c.campaign_id, target_cpa: v },
                                rowKey,
                              )}
                              menu={
                                <>
                                  <DropdownMenuLabel className="text-xs">Ajustar Target CPA</DropdownMenuLabel>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => callMutate("CPA +20%", { action: "adjust_cpa", campaign_id: c.campaign_id, delta_pct: 20 }, rowKey)}>
                                    <ChevronUp className="h-3.5 w-3.5 mr-2 text-warning" /> Aumentar 20%
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => callMutate("CPA +10%", { action: "adjust_cpa", campaign_id: c.campaign_id, delta_pct: 10 }, rowKey)}>
                                    <ChevronUp className="h-3.5 w-3.5 mr-2 text-warning" /> Aumentar 10%
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => callMutate("CPA -10%", { action: "adjust_cpa", campaign_id: c.campaign_id, delta_pct: -10 }, rowKey)}>
                                    <ChevronDown className="h-3.5 w-3.5 mr-2 text-success" /> Reduzir 10%
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => callMutate("CPA -20%", { action: "adjust_cpa", campaign_id: c.campaign_id, delta_pct: -20 }, rowKey)}>
                                    <ChevronDown className="h-3.5 w-3.5 mr-2 text-success" /> Reduzir 20%
                                  </DropdownMenuItem>
                                </>
                              }
                            />
                            <InlineMoneyEdit
                              label="Orç"
                              title={`Orçamento diário – ${c.name}`}
                              value={((c as any)?.budget_micros ?? 0) / 1_000_000}
                              disabled={loading}
                              onSave={(v) => callMutate(
                                `Orçamento definido em ${v.toFixed(2)}`,
                                { action: "set_budget_absolute", campaign_id: c.campaign_id, budget: v },
                                rowKey,
                              )}
                              menu={
                                <>
                                  <DropdownMenuLabel className="text-xs">Ajustar orçamento</DropdownMenuLabel>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => callMutate("Orçamento +20%", { action: "adjust_budget", campaign_id: c.campaign_id, delta_pct: 20 }, rowKey)}>
                                    <ChevronUp className="h-3.5 w-3.5 mr-2 text-success" /> Aumentar 20%
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => callMutate("Orçamento +10%", { action: "adjust_budget", campaign_id: c.campaign_id, delta_pct: 10 }, rowKey)}>
                                    <ChevronUp className="h-3.5 w-3.5 mr-2 text-success" /> Aumentar 10%
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={() => callMutate("Orçamento -10%", { action: "adjust_budget", campaign_id: c.campaign_id, delta_pct: -10 }, rowKey)}>
                                    <ChevronDown className="h-3.5 w-3.5 mr-2 text-warning" /> Reduzir 10%
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => callMutate("Orçamento -20%", { action: "adjust_budget", campaign_id: c.campaign_id, delta_pct: -20 }, rowKey)}>
                                    <ChevronDown className="h-3.5 w-3.5 mr-2 text-warning" /> Reduzir 20%
                                  </DropdownMenuItem>
                                  {onBoost && (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem onClick={() => onBoost(c.campaign_id)}>
                                        <TrendingUp className="h-3.5 w-3.5 mr-2 text-primary" /> Boost (regra interna)
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </>
                              }
                            />
                            <CampaignHistoryButton
                              campaignId={c.campaign_id}
                              campaignName={c.name}
                            />
                            <RestartCampaignButton
                              campaignId={c.campaign_id}
                              campaignName={c.name}
                              googleAccountId={(c as any).google_account_id ?? null}
                              onChanged={() => { restartFlows.refetch(); onRefresh?.(); }}
                            />
                            <AttachHtml5Button
                              campaignId={c.campaign_id}
                              campaignName={c.name}
                              googleAccountId={(c as any).google_account_id ?? null}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  </TableCell>

                  <TableCell className="sticky left-[592px] z-20 w-[300px] min-w-[300px] bg-card border-r border-border text-xs shadow-sm">
                    {finalUrl ? (
                      <div className="flex items-center gap-1 max-w-[280px]">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <a
                              href={finalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 truncate text-primary hover:underline"
                            >
                              <ExternalLink className="h-3 w-3 shrink-0" />
                              <span className="truncate">{shortenUrl(finalUrl)}</span>
                            </a>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-md break-all">
                            {finalUrl}
                          </TooltipContent>
                        </Tooltip>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 shrink-0"
                          title="Copiar URL"
                          onClick={() => copyToClipboard(finalUrl)}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  {isVisible("score") && (
                    <TableCell className="text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn(
                            "inline-flex items-center justify-center rounded-full w-6 h-6 text-sm cursor-help",
                            score.level === "healthy" ? "bg-success-soft" : score.level === "warning" ? "bg-warning/20" : "bg-danger-soft",
                          )}>
                            {score.emoji}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="text-xs">
                          <b>{score.label}</b><br />
                          ROI: {fmtPercent(c.roi)}<br />
                          CTR: {(d?.ctr ?? 0).toFixed(2)}%<br />
                          CPA: {c.conversions > 0 ? fmtCurrency(d?.cpa ?? 0) : "—"}<br />
                          Conv: {fmtNumber(Math.round(c.conversions))}<br />
                          eCPM: {fmtUSD(gamEcpm)}
                          {trend && <><br />Tendência: {trend.diff >= 0 ? "+" : ""}{trend.diff.toFixed(1)}pp</>}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                  )}
                  {isVisible("startDate") && (
                    <TableCell className="text-xs tabular-nums text-muted-foreground">
                      {firstSpend ? firstSpend.slice(5).replace("-", "/") : "—"}
                    </TableCell>
                  )}
                  {isVisible("age") && (
                    <TableCell className="text-right text-xs tabular-nums">
                      {age != null ? <span className="font-semibold">{age}d</span> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  )}
                  {isVisible("lastAction") && (
                    <TableCell className="text-xs">
                      {lastAction ? (
                        <div className="flex flex-col leading-tight">
                          <span className="font-medium truncate max-w-[140px]" title={lastAction.label}>{lastAction.label}</span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">{lastAction.date.slice(0, 10)}</span>
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  )}
                  {isVisible("spend") && (
                    <TableCell className="text-right tabular-nums">{fmtCurrency(c.spend)}</TableCell>
                  )}
                  {isVisible("revenue") && (
                    <TableCell className="text-right tabular-nums">
                      <div>{fmtUSD(c.revenue)}</div>
                      {c.revenue_brl != null && (
                        <div className="text-[10px] text-muted-foreground">
                          ≈ {fmtCurrency(c.revenue_brl)}
                        </div>
                      )}
                    </TableCell>
                  )}
                  {isVisible("profit") && (
                    <TableCell
                      className={cn(
                        "text-right font-semibold tabular-nums",
                        positive ? "text-success" : "text-danger",
                      )}
                    >
                      {fmtCurrency(c.profit)}
                    </TableCell>
                  )}
                  {isVisible("roi") && (
                    <TableCell className="text-right">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                          positive ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                        )}
                      >
                        {fmtPercent(c.roi)}
                      </span>
                    </TableCell>
                  )}
                  {isVisible("trend") && (
                    <TableCell className="text-right">
                      {trendQuery.isLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin inline text-muted-foreground" />
                      ) : !trend || (trend.currentSpend === 0 && trend.prevSpend === 0) ? (
                        <span className="text-muted-foreground text-xs">—</span>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className={cn(
                              "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums cursor-help",
                              Math.abs(trend.diff) < 2 ? "bg-muted text-muted-foreground" :
                              trend.diff > 0 ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                            )}>
                              {Math.abs(trend.diff) < 2 ? <Minus className="h-3 w-3" /> :
                                trend.diff > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                              {trend.diff >= 0 ? "+" : ""}{trend.diff.toFixed(1)}pp
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="text-xs">
                            <b>Tendência ROI</b><br />
                            ROI atual: {trend.currentRoi.toFixed(1)}%<br />
                            ROI anterior: {trend.prevRoi.toFixed(1)}%<br />
                            Diferença: {trend.diff >= 0 ? "+" : ""}{trend.diff.toFixed(1)} pontos<br />
                            <span className="text-muted-foreground">Gasto atual: {fmtCurrency(trend.currentSpend)} • ant: {fmtCurrency(trend.prevSpend)}</span>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                  )}
                  {isVisible("roas") && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {(Number(c.roas) || 0).toFixed(2)}x
                    </TableCell>
                  )}
                  {isVisible("ecpm") && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="cursor-help inline-block text-right">
                            <div className="underline decoration-dotted decoration-muted-foreground/50">{fmtUSD(gamEcpm)}</div>
                            {gamMetric && (
                              <div className="text-[10px] text-muted-foreground">
                                GAM · {fmtNumber(gamMetric.impressions)} impr.
                              </div>
                            )}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="text-xs font-mono whitespace-pre leading-relaxed">
                          {`Receita GAM: $${ecpmDebug.revenueUsd.toFixed(2)}\nImpressões GAM: ${ecpmDebug.impressions.toLocaleString()}\n${ecpmDebug.formula}\neCPM = $${ecpmDebug.ecpm.toFixed(2)}\nFonte: ${ecpmDebug.source}`}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                  )}
                  {isVisible("matchRate") && (() => {
                    const mr = campaignMatchRates?.get(c.campaign_id);
                    const has = !!mr && mr.totalRequests > 0;
                    const pct = mr?.matchRate ?? 0;
                    const color = !has
                      ? "text-muted-foreground"
                      : pct >= 70 ? "text-success"
                      : pct >= 40 ? "text-warning"
                      : "text-danger";
                    return (
                      <TableCell className="text-right tabular-nums">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help inline-block text-right">
                              <div className={cn("underline decoration-dotted decoration-muted-foreground/50", color)}>
                                {has ? `${pct.toFixed(1)}%` : "—"}
                              </div>
                              {has && (
                                <div className="text-[10px] text-muted-foreground">
                                  {fmtNumber(mr!.impressions)} / {fmtNumber(mr!.totalRequests)}
                                </div>
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="text-xs font-mono whitespace-pre leading-relaxed">
                            {has
                              ? `Impressões GAM: ${mr!.impressions.toLocaleString()}\nTotal requests: ${mr!.totalRequests.toLocaleString()}\nMatch Rate = impressões / requests * 100\nMatch Rate = ${pct.toFixed(2)}%\nFonte: gam_campaign_source_revenue (utm_campaign)`
                              : "Sem dados de AD_SERVER_TOTAL_REQUESTS para esta campanha no período. Rode uma sincronização do GAM."}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                    );
                  })()}
                  {isVisible("impressions") && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      <div>{fmtNumber(gamMetric?.impressions ?? c.impressions)}</div>
                      {gamMetric && <div className="text-[10px] text-muted-foreground">GAM</div>}
                    </TableCell>
                  )}
                  {isVisible("clicks") && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {fmtNumber(c.clicks)}
                    </TableCell>
                  )}
                  {isVisible("ctr") && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {(d?.ctr ?? 0).toFixed(2)}%
                    </TableCell>
                  )}
                  {isVisible("conversions") && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {fmtNumber(Math.round(c.conversions))}
                    </TableCell>
                  )}
                  {isVisible("convRate") && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {(d?.convRate ?? 0).toFixed(2)}%
                    </TableCell>
                  )}
                  {isVisible("cpa") && (
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {c.conversions > 0 ? fmtCurrency(d?.cpa ?? 0) : "—"}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
    </TooltipProvider>
  );
}

function InlineMoneyEdit({
  label,
  title,
  value,
  disabled,
  onSave,
  menu,
}: {
  label: string;
  title: string;
  value: number;
  disabled?: boolean;
  onSave: (v: number) => void;
  menu?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value > 0 ? value.toFixed(2) : "");
  useEffect(() => {
    if (!editing) setDraft(value > 0 ? value.toFixed(2) : "");
  }, [value, editing]);

  const commit = () => {
    const v = Number(String(draft).replace(",", "."));
    setEditing(false);
    if (!Number.isFinite(v) || v <= 0) {
      if ((draft ?? "") !== "") toast({ title: "Valor inválido", variant: "destructive" });
      setDraft(value > 0 ? value.toFixed(2) : "");
      return;
    }
    if (Math.abs(v - value) < 0.005) return;
    onSave(v);
  };

  return (
    <div className="inline-flex items-center h-8 rounded-md border bg-background overflow-hidden">
      <span className="px-1.5 text-[10px] font-medium text-muted-foreground border-r select-none">{label}</span>
      {editing ? (
        <Input
          autoFocus
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { setDraft(value > 0 ? value.toFixed(2) : ""); setEditing(false); }
          }}
          className="h-8 w-20 border-0 rounded-none px-1.5 text-xs tabular-nums focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      ) : (
        <button
          type="button"
          title={`Editar – ${title}`}
          disabled={disabled}
          onClick={() => setEditing(true)}
          className="h-8 px-2 text-xs tabular-nums hover:bg-muted/60 disabled:opacity-50 flex items-center gap-1"
        >
          {value > 0 ? value.toFixed(2) : "—"}
          <Pencil className="h-3 w-3 text-muted-foreground" />
        </button>
      )}
      {menu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="h-8 px-1.5 border-l hover:bg-muted/60 disabled:opacity-50 flex items-center"
              title="Ajustes rápidos (±%)"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {menu}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

