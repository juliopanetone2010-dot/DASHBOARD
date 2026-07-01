import { useEffect, useMemo, useState } from "react";
import { Pause, Play, TrendingUp, ChevronDown, ChevronUp, ChevronsUpDown, ChevronsLeft, ChevronsRight, Loader2, ShieldX, ExternalLink, Copy, RotateCcw, Columns3, AlertTriangle, CheckCircle2, XCircle, ArrowUp, ArrowDown, Minus, Activity, Pencil, Tag, X } from "lucide-react";
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
import { useColumnLayout } from "@/hooks/useColumnLayout";
import { ColumnManagerDropdown } from "./ColumnManagerDropdown";
import { MatchRateDebugDialog } from "./MatchRateDebugDialog";
import { type BestMatchInfo, matchRateColor, formatBrDate } from "@/lib/bestMatch";
import { normalizePushUrl } from "@/lib/normalizePushUrl";

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

// === Marcadores operacionais manuais ===
export type OpStatusKey =
  | "observation" | "scaling" | "recovering" | "restarted" | "attention"
  | "waiting_data" | "recovered" | "pricing_change" | "new_creative" | "new_budget";
export const OP_STATUS_OPTIONS: Array<{ key: OpStatusKey; label: string; emoji: string; className: string }> = [
  { key: "observation",    label: "Em observação",            emoji: "🟠", className: "bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/40" },
  { key: "scaling",        label: "Escalando",                emoji: "🔵", className: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/40" },
  { key: "recovering",     label: "Recuperando",              emoji: "🟡", className: "bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/40" },
  { key: "restarted",      label: "Reiniciada",               emoji: "🟣", className: "bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/40" },
  { key: "attention",      label: "Atenção",                  emoji: "🔴", className: "bg-red-100 text-red-700 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/40" },
  { key: "waiting_data",   label: "Aguardando dados",         emoji: "⚪", className: "bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-500/15 dark:text-zinc-300 dark:border-zinc-500/40" },
  { key: "recovered",      label: "Recuperada",               emoji: "🟢", className: "bg-green-100 text-green-700 border-green-300 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/40" },
  { key: "pricing_change", label: "Mudança de precificação",  emoji: "🟤", className: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-700/20 dark:text-amber-300 dark:border-amber-700/40" },
  { key: "new_creative",   label: "Novo criativo",            emoji: "🟦", className: "bg-sky-100 text-sky-700 border-sky-300 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/40" },
  { key: "new_budget",     label: "Novo orçamento",           emoji: "🟨", className: "bg-yellow-200 text-yellow-900 border-yellow-400 dark:bg-yellow-600/20 dark:text-yellow-200 dark:border-yellow-600/40" },
];
const OP_STATUS_MAP: Record<string, (typeof OP_STATUS_OPTIONS)[number]> =
  Object.fromEntries(OP_STATUS_OPTIONS.map((o) => [o.key, o])) as any;

function timeAgoPt(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "agora";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `há ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 0) return "hoje";
  if (days === 1) return "há 1 dia";
  return `há ${days} dias`;
}

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
  campaignBestMatches?: Map<string, BestMatchInfo>;
  downAccountIds?: Set<string>;
  onPause?: (campaignId: string) => void;
  onBoost?: (campaignId: string) => void;
  onRefresh?: () => Promise<void> | void;
  dateRange?: { from: string; to: string };
  siteId?: string;
}

export function CampaignsTable({ campaigns, campaignGamMetrics, campaignMatchRates, campaignBestMatches, downAccountIds, onPause, onBoost, onRefresh, dateRange, siteId }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const restartFlows = useRestartFlows();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBudget, setBulkBudget] = useState<number>(40);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Padrão: ROI DESC. null = sem ordenação (ordem original)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>({ key: "roi", dir: "desc" });
  const [trendPeriod, setTrendPeriod] = useState<TrendPeriod>("7d");
  const [matchRateDebug, setMatchRateDebug] = useState<{ campaignId: string; campaignName?: string | null } | null>(null);
  const [compactNameUrl, setCompactNameUrl] = useState(false);
  const NAME_W = compactNameUrl ? 220 : 560;
  const URL_W = compactNameUrl ? 220 : 560;
  const NAME_LEFT = 172;
  const URL_LEFT = NAME_LEFT + NAME_W;

  // ===== Customização de colunas (persistido em localStorage) =====
  type ColKey =
    | "score" | "startDate" | "age" | "lastAction"
    | "spend" | "revenue" | "profit" | "roi" | "trend" | "roas"
    | "ecpm" | "matchRate" | "bestMatch" | "deltaMatch" | "impressions" | "clicks" | "ctr"
    | "conversions" | "convRate" | "cpa" | "finalUrl"
    | "act_pause" | "act_cpa" | "act_budget" | "act_history" | "act_restart" | "act_html5";
  const ALL_COLUMNS: Array<{ key: ColKey; label: string; width: number }> = [
    { key: "score", label: "Saúde", width: 60 },
    { key: "startDate", label: "Início gasto", width: 100 },
    { key: "age", label: "Idade", width: 70 },
    { key: "lastAction", label: "Última ação", width: 140 },
    { key: "spend", label: "Gasto", width: 100 },
    { key: "revenue", label: "Receita", width: 110 },
    { key: "profit", label: "Lucro", width: 110 },
    { key: "roi", label: "ROI", width: 90 },
    { key: "trend", label: "Tendência", width: 100 },
    { key: "roas", label: "ROAS", width: 80 },
    { key: "ecpm", label: "eCPM", width: 100 },
    { key: "bestMatch", label: "Melhor Match", width: 160 },
    { key: "deltaMatch", label: "Δ Match", width: 100 },
    { key: "impressions", label: "Impr.", width: 100 },
    { key: "clicks", label: "Cliques", width: 80 },
    { key: "ctr", label: "CTR", width: 70 },
    { key: "conversions", label: "Conv.", width: 80 },
    { key: "convRate", label: "Tx. Conv.", width: 90 },
    { key: "cpa", label: "CPA", width: 90 },
    { key: "finalUrl", label: "Final URL", width: 560 },
    { key: "act_pause", label: "Ação · Pause", width: 56 },
    { key: "act_cpa", label: "Ação · CPA", width: 120 },
    { key: "act_budget", label: "Ação · Orçamento", width: 120 },
    { key: "act_history", label: "Ação · Histórico", width: 110 },
    { key: "act_restart", label: "Ação · Reiniciar", width: 110 },
    { key: "act_html5", label: "Ação · HTML5", width: 90 },
  ];
  const ALL_KEYS = ALL_COLUMNS.map((c) => c.key);
  const DEFAULT_WIDTHS = Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c.width])) as Record<ColKey, number>;
  const layout = useColumnLayout({
    storageKeyOrder: "campaigns-table-col-order-v1",
    storageKeyWidths: "campaigns-table-col-widths-v1",
    storageKeyVisible: "campaigns-table-visible-cols-v5",
    allKeys: ALL_KEYS,
    defaultWidths: DEFAULT_WIDTHS,
  });
  const visibleCols = layout.visible as Set<ColKey>;
  const isVisible = (k: ColKey) => visibleCols.has(k);
  const orderedVisible = (layout.order as ColKey[]).filter((k) => isVisible(k));
  const widthStyle = (k: ColKey): React.CSSProperties => {
    const w = layout.widths[k] ?? DEFAULT_WIDTHS[k];
    return { width: w, minWidth: w, maxWidth: w };
  };

  type HeadDef = { label: string; sortKey?: SortKey; align?: "left" | "right" };
  const HEAD_DEFS: Record<ColKey, HeadDef> = {
    score: { label: "Saúde", sortKey: "score", align: "right" },
    startDate: { label: "Início gasto", align: "left" },
    age: { label: "Idade", sortKey: "age", align: "right" },
    lastAction: { label: "Última ação", align: "left" },
    spend: { label: "Gasto", sortKey: "spend", align: "right" },
    revenue: { label: "Receita", sortKey: "revenue", align: "right" },
    profit: { label: "Lucro", sortKey: "profit", align: "right" },
    roi: { label: "ROI", sortKey: "roi", align: "right" },
    trend: { label: "Tendência", sortKey: "trend", align: "right" },
    roas: { label: "ROAS", sortKey: "roas", align: "right" },
    ecpm: { label: "eCPM", sortKey: "ecpm", align: "right" },
    matchRate: { label: "Taxa Corresp.", align: "right" },
    bestMatch: { label: "Melhor Match", align: "right" },
    deltaMatch: { label: "Δ Match", align: "right" },
    impressions: { label: "Impr.", sortKey: "impressions", align: "right" },
    clicks: { label: "Cliques", sortKey: "clicks", align: "right" },
    ctr: { label: "CTR", sortKey: "ctr", align: "right" },
    conversions: { label: "Conv.", sortKey: "conversions", align: "right" },
    convRate: { label: "Tx. Conv.", sortKey: "convRate", align: "right" },
    cpa: { label: "CPA", sortKey: "cpa", align: "right" },
    finalUrl: { label: "Final URL", align: "left" },
    act_pause: { label: "Pausa", align: "left" },
    act_cpa: { label: "Aj. CPA", align: "left" },
    act_budget: { label: "Aj. Orç.", align: "left" },
    act_history: { label: "Histórico", align: "left" },
    act_restart: { label: "Reiniciar", align: "left" },
    act_html5: { label: "HTML5", align: "left" },
  };




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

  // ===== Agrupamento de campanhas por Final URL (normalizada) =====
  type UrlGroupItem = { campaign_id: string; name: string; roi: number; status: string };
  const urlGroups = useMemo(() => {
    const groups = new Map<string, UrlGroupItem[]>();
    const urlMap = finalUrlsQuery.data;
    if (!urlMap) return groups;
    for (const c of campaigns) {
      const raw = urlMap.get(c.campaign_id);
      if (!raw) continue;
      const key = normalizePushUrl(raw);
      if (!key) continue;
      const arr = groups.get(key) ?? [];
      arr.push({
        campaign_id: c.campaign_id,
        name: c.name,
        roi: Number(c.roi) || 0,
        status: c.status,
      });
      groups.set(key, arr);
    }
    return groups;
  }, [campaigns, finalUrlsQuery.data]);
  const [urlGroupOpen, setUrlGroupOpen] = useState<{ url: string; items: UrlGroupItem[] } | null>(null);

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

  // === Marcador operacional (manual) por campanha ===
  type OpStatusRow = {
    operational_status: string | null;
    operational_status_at: string | null;
    operational_status_expires_at: string | null;
    operational_note: string | null;
  };
  const [opStatusFilter, setOpStatusFilter] = useState<OpStatusKey | "all">("all");
  const opStatusQuery = useQuery({
    queryKey: ["campaign-op-status", campaignIds.join("|")],
    queryFn: async () => {
      const out = new Map<string, OpStatusRow>();
      if (campaignIds.length === 0) return out;
      const { data } = await supabase
        .from("campaigns")
        .select("campaign_id, operational_status, operational_status_at, operational_status_expires_at, operational_note")
        .in("campaign_id", campaignIds)
        .not("operational_status", "is", null);
      const now = Date.now();
      for (const r of (data ?? []) as any[]) {
        if (r.operational_status_expires_at && new Date(r.operational_status_expires_at).getTime() < now) continue;
        out.set(r.campaign_id, {
          operational_status: r.operational_status,
          operational_status_at: r.operational_status_at,
          operational_status_expires_at: r.operational_status_expires_at,
          operational_note: r.operational_note,
        });
      }
      return out;
    },
    staleTime: 30_000,
    enabled: campaignIds.length > 0,
  });
  const setOpStatus = async (campaign_id: string, status: OpStatusKey | null, expiresDays: number | null = null) => {
    const patch: any = {
      operational_status: status,
      operational_status_at: status ? new Date().toISOString() : null,
      operational_status_expires_at: status && expiresDays
        ? new Date(Date.now() + expiresDays * 86400000).toISOString()
        : null,
    };
    const { error } = await supabase.from("campaigns").update(patch).eq("campaign_id", campaign_id);
    if (error) {
      toast({ title: "Erro ao marcar status", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: status ? `Marcado: ${OP_STATUS_MAP[status].label}` : "Marcador removido" });
    await opStatusQuery.refetch();
  };



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

  const filteredCampaigns = useMemo(() => {
    if (opStatusFilter === "all") return campaigns;
    return campaigns.filter((c) => opStatusQuery.data?.get(c.campaign_id)?.operational_status === opStatusFilter);
  }, [campaigns, opStatusFilter, opStatusQuery.data]);

  const sortedCampaigns = useMemo(() => {
    if (!sort) return filteredCampaigns;
    const arr = [...filteredCampaigns];
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
  }, [filteredCampaigns, sort, derived, campaignGamMetrics, firstSpendQuery.data, trendQuery.data]);


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
      return `${u.hostname.replace(/^www\./, "")}${u.pathname}`;
    } catch {
      return url;
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
            <Tag className="h-3.5 w-3.5" />
            <span>Marcador:</span>
            <select
              value={opStatusFilter}
              onChange={(e) => setOpStatusFilter(e.target.value as any)}
              className="h-7 rounded-md border border-input bg-background px-1.5 text-[11px]"
            >
              <option value="all">Todos</option>
              {OP_STATUS_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.emoji} {o.label}</option>
              ))}
            </select>
            {opStatusFilter !== "all" && (
              <button
                type="button"
                onClick={() => setOpStatusFilter("all")}
                className="ml-1 inline-flex items-center text-muted-foreground hover:text-foreground"
                title="Limpar filtro"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

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
          <ColumnManagerDropdown
            columns={ALL_COLUMNS.map((c) => ({ key: c.key, label: c.label }))}
            order={layout.order}
            visible={layout.visible}
            onOrderChange={layout.setOrder}
            onToggleVisible={layout.toggleVisible}
            onReset={layout.resetAll}
            presets={layout.presets}
            onSavePreset={layout.savePreset}
            onApplyPreset={layout.applyPreset}
            onDeletePreset={layout.deletePreset}
          />

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
              <TableHead
                style={{ left: `${NAME_LEFT}px`, width: `${NAME_W}px`, minWidth: `${NAME_W}px` }}
                className="sticky z-30 bg-muted/95 border-r border-border shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span>Nome</span>
                  <button
                    type="button"
                    onClick={() => setCompactNameUrl((v) => !v)}
                    title={compactNameUrl ? "Expandir colunas Nome / Final URL" : "Encurtar colunas Nome / Final URL"}
                    className="inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-background hover:bg-accent text-muted-foreground hover:text-foreground"
                  >
                    {compactNameUrl ? <ChevronsRight className="h-3 w-3" /> : <ChevronsLeft className="h-3 w-3" />}
                  </button>
                </div>
              </TableHead>
              {orderedVisible.map((k) => {
                const def = HEAD_DEFS[k];
                const active = !!def.sortKey && sort?.key === def.sortKey;
                return (
                  <TableHead
                    key={k}
                    style={widthStyle(k)}
                    className={cn(
                      "relative whitespace-nowrap text-xs",
                      def.align === "right" ? "text-right" : "text-left",
                      active && "bg-primary/5",
                    )}
                  >
                    {def.sortKey ? (
                      <button
                        type="button"
                        onClick={() => handleSort(def.sortKey!)}
                        className={cn(
                          "inline-flex items-center gap-1 select-none hover:text-foreground transition-colors",
                          def.align === "right" && "ml-auto",
                          active ? "text-foreground font-semibold" : "text-muted-foreground",
                        )}
                      >
                        {def.label}
                        <SortIcon k={def.sortKey} />
                      </button>
                    ) : (
                      <span className={cn(def.align === "right" && "block text-right")}>{def.label}</span>
                    )}
                    <div
                      onPointerDown={(e) => layout.startResize(k, e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/60 active:bg-primary"
                      role="separator"
                      aria-label="Redimensionar coluna"
                    />
                  </TableHead>
                );
              })}

            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedCampaigns.length === 0 && (
              <TableRow>
                <TableCell colSpan={3 + visibleCols.size} className="text-center text-muted-foreground py-10">
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
              const ecpmDebug = calculateCampaignEcpm(gamMetric?.revenueUsd ?? 0, gamMetric?.impressions ?? 0, "gam_campaign_source_revenue (utm_source=google)");
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
                  <TableCell
                    style={{ left: `${NAME_LEFT}px`, width: `${NAME_W}px`, minWidth: `${NAME_W}px` }}
                    className="sticky z-20 bg-card border-r border-border font-medium shadow-sm"
                  >
                    <div className={cn("flex items-center gap-2", compactNameUrl ? "whitespace-nowrap" : "whitespace-normal")}>
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
                      {finalUrl ? (
                        <a
                          href={finalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn("min-w-0 flex-1 leading-snug text-primary hover:underline", compactNameUrl ? "truncate" : "break-words", accountDown && "text-danger")}
                          title={finalUrl}
                        >
                          {c.name}
                        </a>
                      ) : (
                        <span className={cn("min-w-0 flex-1 leading-snug", compactNameUrl ? "truncate" : "break-words", accountDown && "text-danger")} title={c.name}>{c.name}</span>
                      )}
                      {accountDown && (
                        <Badge variant="destructive" className="text-[10px] gap-1">
                          <ShieldX className="h-3 w-3" /> Conta suspensa
                        </Badge>
                      )}
                      <RestartStatusBadge flow={restartFlows.data?.get(c.campaign_id)} />
                      {(() => {
                        const op = opStatusQuery.data?.get(c.campaign_id);
                        const def = op?.operational_status ? OP_STATUS_MAP[op.operational_status] : null;
                        return (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              {def ? (
                                <button
                                  type="button"
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none transition-opacity hover:opacity-80",
                                    def.className,
                                  )}
                                  title={`${def.label} · marcado ${timeAgoPt(op!.operational_status_at)}${op!.operational_status_expires_at ? ` · expira ${timeAgoPt(op!.operational_status_expires_at).replace("há ", "em ").replace("em -", "há ")}` : ""}`}
                                >
                                  <span>{def.emoji}</span>
                                  <span>{def.label}</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="inline-flex h-5 items-center gap-1 rounded-full border border-dashed border-muted-foreground/40 px-1.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-100"
                                  title="Marcar status"
                                >
                                  <Tag className="h-3 w-3" /> marcar
                                </button>
                              )}
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56">
                              <DropdownMenuLabel className="text-[11px]">Marcar status</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {OP_STATUS_OPTIONS.map((o) => (
                                <DropdownMenuItem
                                  key={o.key}
                                  className="text-xs"
                                  onClick={() => setOpStatus(c.campaign_id, o.key, null)}
                                >
                                  <span className="mr-2">{o.emoji}</span>
                                  <span className="flex-1">{o.label}</span>
                                  {def?.key === o.key && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
                                </DropdownMenuItem>
                              ))}
                              {def && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuLabel className="text-[10px] text-muted-foreground">Expirar marcador em</DropdownMenuLabel>
                                  {[1, 3, 7, 14].map((d) => (
                                    <DropdownMenuItem
                                      key={d}
                                      className="text-xs"
                                      onClick={() => setOpStatus(c.campaign_id, def.key, d)}
                                    >
                                      em {d} {d === 1 ? "dia" : "dias"}
                                    </DropdownMenuItem>
                                  ))}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-xs text-danger focus:text-danger"
                                    onClick={() => setOpStatus(c.campaign_id, null)}
                                  >
                                    <X className="mr-2 h-3.5 w-3.5" /> Remover marcador
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        );
                      })()}
                    </div>
                  </TableCell>

                  {orderedVisible.map((k) => {
                    const ws = widthStyle(k);
                    switch (k) {
                      case "score":
                        return (
                          <TableCell key={k} style={ws} className="text-right">
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
                        );
                      case "startDate":
                        return (
                          <TableCell key={k} style={ws} className="text-xs tabular-nums text-muted-foreground">
                            {firstSpend ? firstSpend.slice(5).replace("-", "/") : "—"}
                          </TableCell>
                        );
                      case "age":
                        return (
                          <TableCell key={k} style={ws} className="text-right text-xs tabular-nums">
                            {age != null ? <span className="font-semibold">{age}d</span> : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                        );
                      case "lastAction":
                        return (
                          <TableCell key={k} style={ws} className="text-xs">
                            {lastAction ? (
                              <div className="flex flex-col leading-tight">
                                <span className="font-medium truncate" title={lastAction.label}>{lastAction.label}</span>
                                <span className="text-[10px] text-muted-foreground tabular-nums">{lastAction.date.slice(0, 10)}</span>
                              </div>
                            ) : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                        );
                      case "spend":
                        return <TableCell key={k} style={ws} className="text-right tabular-nums">{fmtCurrency(c.spend)}</TableCell>;
                      case "revenue":
                        return (
                          <TableCell key={k} style={ws} className="text-right tabular-nums">
                            <div>{fmtUSD(c.revenue)}</div>
                            {c.revenue_brl != null && (
                              <div className="text-[10px] text-muted-foreground">≈ {fmtCurrency(c.revenue_brl)}</div>
                            )}
                          </TableCell>
                        );
                      case "profit":
                        return (
                          <TableCell key={k} style={ws} className={cn("text-right font-semibold tabular-nums", positive ? "text-success" : "text-danger")}>
                            {fmtCurrency(c.profit)}
                          </TableCell>
                        );
                      case "roi":
                        return (
                          <TableCell key={k} style={ws} className="text-right">
                            <span className={cn(
                              "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                              positive ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                            )}>
                              {fmtPercent(c.roi)}
                            </span>
                          </TableCell>
                        );
                      case "trend":
                        return (
                          <TableCell key={k} style={ws} className="text-right">
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
                        );
                      case "roas":
                        return <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">{(Number(c.roas) || 0).toFixed(2)}x</TableCell>;
                      case "ecpm":
                        return (
                          <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="cursor-help inline-block text-right">
                                  <div className="underline decoration-dotted decoration-muted-foreground/50">{fmtUSD(gamEcpm)}</div>
                                  {gamMetric && (
                                    <div className="text-[10px] text-muted-foreground">GAM · {fmtNumber(gamMetric.impressions)} impr.</div>
                                  )}
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="text-xs font-mono whitespace-pre leading-relaxed">
                                {`Receita GAM: $${ecpmDebug.revenueUsd.toFixed(2)}\nImpressões GAM: ${ecpmDebug.impressions.toLocaleString()}\n${ecpmDebug.formula}\neCPM = $${ecpmDebug.ecpm.toFixed(2)}\nFonte: ${ecpmDebug.source}`}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        );
                      case "matchRate": {
                        const mr = campaignMatchRates?.get(c.campaign_id);
                        const has = !!mr && (mr.totalRequests > 0 || mr.matchRate > 0);
                        const pct = mr?.matchRate ?? 0;
                        const color = !has ? "text-muted-foreground" : pct >= 70 ? "text-success" : pct >= 40 ? "text-warning" : "text-danger";
                        return (
                          <TableCell key={k} style={ws} className="text-right tabular-nums">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => setMatchRateDebug({ campaignId: c.campaign_id, campaignName: c.name })}
                                  className="inline-block text-right hover:opacity-80 transition-opacity"
                                >
                                  <div className={cn("underline decoration-dotted decoration-muted-foreground/50", color)}>
                                    {has ? `${pct.toFixed(2)}%` : "—"}
                                  </div>
                                  {has && mr!.totalRequests > 0 && (
                                    <div className="text-[10px] text-muted-foreground">
                                      {fmtNumber(mr!.impressions)} / {fmtNumber(mr!.totalRequests)}
                                    </div>
                                  )}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="text-xs font-mono whitespace-pre leading-relaxed">
                                {has
                                  ? `Match Rate (média ponderada por impressões): ${pct.toFixed(2)}%\nImpressões: ${mr!.impressions.toLocaleString()}\nTotal requests: ${mr!.totalRequests.toLocaleString()}\nFonte: gam_campaign_source_revenue (match_rate_pct do GAM)\n\nClique para abrir debug detalhado`
                                  : "Sem dados de requests para esta campanha no período. Clique para abrir debug."}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        );
                      }
                      case "bestMatch": {
                        const info = campaignBestMatches?.get(c.campaign_id);
                        const best = info?.best;
                        if (!best) {
                          return <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">—</TableCell>;
                        }
                        const color = matchRateColor(best.matchRate);
                        return (
                          <TableCell key={k} style={ws} className="text-right tabular-nums">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="cursor-help inline-block text-right">
                                  <div className={cn("font-semibold underline decoration-dotted decoration-muted-foreground/40", color)}>
                                    {best.matchRate.toFixed(2)}%
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">{formatBrDate(best.date)}</div>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="text-xs font-mono whitespace-pre leading-relaxed">
                                {`Melhor Match dos últimos 10 dias\n${formatBrDate(best.date)} (${best.date})\n${best.matchRate.toFixed(2)}%\nMatched: ${best.matched.toLocaleString()}\nRequests: ${best.requests.toLocaleString()}`}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        );
                      }
                      case "deltaMatch": {
                        const info = campaignBestMatches?.get(c.campaign_id);
                        const cur = campaignMatchRates?.get(c.campaign_id)?.matchRate ?? info?.today?.matchRate ?? null;
                        const best = info?.best?.matchRate ?? null;
                        if (cur == null || best == null) {
                          return <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">—</TableCell>;
                        }
                        const delta = cur - best;
                        const color = delta >= 0 ? "text-success" : delta >= -5 ? "text-warning" : "text-danger";
                        return (
                          <TableCell key={k} style={ws} className="text-right tabular-nums">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className={cn("cursor-help font-medium", color)}>
                                  {delta >= 0 ? "+" : ""}{delta.toFixed(1)} pp
                                </div>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="text-xs font-mono whitespace-pre leading-relaxed">
                                {`Atual: ${cur.toFixed(2)}%\nMelhor (10d): ${best.toFixed(2)}%\nΔ: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} pp`}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                        );
                      }
                      case "impressions":
                        return (
                          <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">
                            <div>{fmtNumber(gamMetric?.impressions ?? c.impressions)}</div>
                            {gamMetric && <div className="text-[10px] text-muted-foreground">GAM</div>}
                          </TableCell>
                        );
                      case "clicks":
                        return <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">{fmtNumber(c.clicks)}</TableCell>;
                      case "ctr":
                        return <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">{(d?.ctr ?? 0).toFixed(2)}%</TableCell>;
                      case "conversions":
                        return <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">{fmtNumber(Math.round(c.conversions))}</TableCell>;
                      case "convRate":
                        return <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">{(d?.convRate ?? 0).toFixed(2)}%</TableCell>;
                      case "cpa":
                        return <TableCell key={k} style={ws} className="text-right tabular-nums text-muted-foreground">{c.conversions > 0 ? fmtCurrency(d?.cpa ?? 0) : "—"}</TableCell>;
                      case "act_pause":
                        return (
                          <TableCell key={k} style={ws}>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={loading}
                              className={cn("h-8 px-2", isPaused ? "text-success hover:text-success" : "text-warning hover:text-warning")}
                              title={isPaused ? "Ativar campanha" : "Pausar campanha"}
                              onClick={() => callMutate(
                                isPaused ? "Campanha ativada" : "Campanha pausada",
                                { action: "set_status", campaign_id: c.campaign_id, status: isPaused ? "ENABLED" : "PAUSED" },
                                rowKey,
                              )}
                            >
                              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                            </Button>
                          </TableCell>
                        );
                      case "act_cpa":
                        return (
                          <TableCell key={k} style={ws}>
                            <InlineMoneyEdit
                              label="CPA"
                              title={`Target CPA (ad groups) – ${c.name}`}
                              value={(c as any)?.target_cpa_micros ? ((c as any).target_cpa_micros / 1_000_000) : null}
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
                          </TableCell>
                        );
                      case "act_budget":
                        return (
                          <TableCell key={k} style={ws}>
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
                          </TableCell>
                        );
                      case "act_history":
                        return (
                          <TableCell key={k} style={ws}>
                            <CampaignHistoryButton campaignId={c.campaign_id} campaignName={c.name} />
                          </TableCell>
                        );
                      case "act_restart":
                        return (
                          <TableCell key={k} style={ws}>
                            <RestartCampaignButton
                              campaignId={c.campaign_id}
                              campaignName={c.name}
                              googleAccountId={(c as any).google_account_id ?? null}
                              onChanged={() => { restartFlows.refetch(); onRefresh?.(); }}
                            />
                          </TableCell>
                        );
                      case "act_html5":
                        return (
                          <TableCell key={k} style={ws}>
                            <AttachHtml5Button
                              campaignId={c.campaign_id}
                              campaignName={c.name}
                              googleAccountId={(c as any).google_account_id ?? null}
                            />
                          </TableCell>
                       );
                      case "finalUrl":
                        return (
                          <TableCell key={k} style={ws}>
                            {finalUrl ? (() => {
                              const groupKey = normalizePushUrl(finalUrl);
                              const items = urlGroups.get(groupKey) ?? [];
                              const count = items.length;
                              const badgeClass =
                                count >= 10 ? "bg-red-100 text-red-700 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/40" :
                                count >= 5  ? "bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/40" :
                                count >= 2  ? "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/40" :
                                              "bg-green-100 text-green-700 border-green-300 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/40";
                              return (
                                <div className="flex items-center gap-1 flex-wrap">
                                  <a
                                    href={finalUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-primary hover:underline break-all"
                                  >
                                    <ExternalLink className="h-3 w-3 shrink-0" />
                                    {finalUrl}
                                  </a>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 w-6 p-0 shrink-0"
                                    title="Copiar URL"
                                    onClick={() => copyToClipboard(finalUrl)}
                                  >
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                  {count > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => setUrlGroupOpen({ url: finalUrl, items })}
                                      className={cn(
                                        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold shrink-0 hover:opacity-80 transition",
                                        badgeClass,
                                      )}
                                      title="Ver campanhas com esta mesma URL"
                                    >
                                      Usada em {count} {count === 1 ? "campanha" : "campanhas"}
                                    </button>
                                  )}
                                </div>
                              );
                            })() : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        );
                      default:
                        return null;
                    }
                  })}
                </TableRow>


              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
    {matchRateDebug && dateRange && (
      <MatchRateDebugDialog
        open={!!matchRateDebug}
        onOpenChange={(v) => { if (!v) setMatchRateDebug(null); }}
        campaignId={matchRateDebug.campaignId}
        campaignName={matchRateDebug.campaignName}
        from={dateRange.from}
        to={dateRange.to}
        siteId={siteId}
        dashboardRate={campaignMatchRates?.get(matchRateDebug.campaignId)?.matchRate ?? null}
        dashboardImpressions={campaignMatchRates?.get(matchRateDebug.campaignId)?.impressions ?? null}
        dashboardTotalRequests={campaignMatchRates?.get(matchRateDebug.campaignId)?.totalRequests ?? null}
      />
    )}
    <Dialog open={!!urlGroupOpen} onOpenChange={(v) => { if (!v) setUrlGroupOpen(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Campanhas com a mesma Final URL</DialogTitle>
          <DialogDescription className="break-all">{urlGroupOpen?.url}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign ID</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead className="text-right">ROI</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(urlGroupOpen?.items ?? []).map((it) => (
                <TableRow key={it.campaign_id}>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{it.campaign_id}</TableCell>
                  <TableCell className="font-medium">{it.name}</TableCell>
                  <TableCell className={cn("text-right font-semibold", it.roi >= 0 ? "text-success" : "text-danger")}>
                    {fmtPercent(it.roi)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {it.status === "enabled" ? "Ativa" : it.status === "paused" ? "Pausada" : it.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
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
  value: number | null | undefined;
  disabled?: boolean;
  onSave: (v: number) => void;
  menu?: React.ReactNode;
}) {
  const numeric = value ?? 0;
  const hasValue = numeric > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(hasValue ? numeric.toFixed(2) : "");
  useEffect(() => {
    if (!editing) setDraft(hasValue ? numeric.toFixed(2) : "");
  }, [numeric, editing]);

  const commit = () => {
    const v = Number(String(draft).replace(",", "."));
    setEditing(false);
    if (!Number.isFinite(v) || v <= 0) {
      if ((draft ?? "") !== "") toast({ title: "Valor inválido", variant: "destructive" });
      setDraft(hasValue ? numeric.toFixed(2) : "");
      return;
    }
    if (Math.abs(v - numeric) < 0.005) return;
    onSave(v);
  };

  if (!hasValue) {
    return <span className="px-2 text-xs text-muted-foreground tabular-nums">—</span>;
  }

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
            if (e.key === "Escape") { setDraft(hasValue ? numeric.toFixed(2) : ""); setEditing(false); }
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
          {numeric.toFixed(2)}
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

