import { useEffect, useMemo, useState } from "react";
import { Pause, Play, TrendingUp, ChevronDown, ChevronUp, ChevronsUpDown, Loader2, ShieldX, ExternalLink, Copy, RotateCcw, Columns3 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { fmtCurrency, fmtUSD, fmtPercent, fmtNumber } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { CampaignAggregate } from "@/types/domain";
import { RestartCampaignButton, RestartStatusBadge, useRestartFlows } from "./RestartCampaignButton";
import { AttachHtml5Button } from "./AttachHtml5Button";
import { CampaignHistoryButton } from "./CampaignHistoryButton";
import { calculateCampaignEcpm } from "@/lib/campaignEcpm";

type SortKey = "spend" | "revenue" | "profit" | "roi" | "roas" | "ecpm" | "clicks" | "conversions" | "ctr" | "convRate" | "cpa" | "impressions" | "age";
type SortDir = "desc" | "asc";

interface Props {
  campaigns: CampaignAggregate[];
  campaignGamMetrics?: Map<string, { ecpm: number; impressions: number; revenueUsd?: number }>;
  downAccountIds?: Set<string>;
  onPause?: (campaignId: string) => void;
  onBoost?: (campaignId: string) => void;
  onRefresh?: () => Promise<void> | void;
}

export function CampaignsTable({ campaigns, campaignGamMetrics, downAccountIds, onPause, onBoost, onRefresh }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const restartFlows = useRestartFlows();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBudget, setBulkBudget] = useState<number>(40);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Padrão: ROI DESC. null = sem ordenação (ordem original)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>({ key: "roi", dir: "desc" });

  // ===== Customização de colunas (persistido em localStorage) =====
  type ColKey = "startDate" | "age" | "lastAction" | "spend" | "revenue" | "profit" | "roi" | "roas" | "ecpm" | "impressions" | "clicks" | "ctr" | "conversions" | "convRate" | "cpa";
  const ALL_COLUMNS: Array<{ key: ColKey; label: string }> = [
    { key: "startDate", label: "Início gasto" },
    { key: "age", label: "Idade" },
    { key: "lastAction", label: "Última ação" },
    { key: "spend", label: "Gasto" },
    { key: "revenue", label: "Receita" },
    { key: "profit", label: "Lucro" },
    { key: "roi", label: "ROI" },
    { key: "roas", label: "ROAS" },
    { key: "ecpm", label: "eCPM" },
    { key: "impressions", label: "Impr." },
    { key: "clicks", label: "Cliques" },
    { key: "ctr", label: "CTR" },
    { key: "conversions", label: "Conv." },
    { key: "convRate", label: "Tx. Conv." },
    { key: "cpa", label: "CPA" },
  ];
  const STORAGE_KEY = "campaigns-table-visible-cols-v1";
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

  // Primeiro dia com spend > 0 por campanha (idade real desde início do gasto)
  const firstSpendQuery = useQuery({
    queryKey: ["campaign-first-spend", campaignIds.join("|")],
    queryFn: async () => {
      if (campaignIds.length === 0) return new Map<string, string>();
      const { data } = await supabase
        .from("daily_metrics")
        .select("campaign_id, date")
        .in("campaign_id", campaignIds)
        .gt("spend", 0)
        .order("date", { ascending: true })
        .limit(50000);
      const map = new Map<string, string>();
      for (const r of (data ?? []) as Array<{ campaign_id: string; date: string }>) {
        if (!map.has(r.campaign_id)) map.set(r.campaign_id, r.date);
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
        default: return Number((c as any)[sort.key] ?? 0);
      }
    };
    arr.sort((a, b) => {
      const av = valueOf(a), bv = valueOf(b);
      if (av === bv) return 0;
      return av < bv ? -1 * mult : 1 * mult;
    });
    return arr;
  }, [campaigns, sort, derived, campaignGamMetrics, firstSpendQuery.data]);

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
              <TableHead className="sticky left-[172px] z-30 w-[260px] min-w-[260px] bg-muted/95 border-r border-border shadow-sm">Nome</TableHead>
              <TableHead className="sticky left-[432px] z-30 w-[300px] min-w-[300px] bg-muted/95 border-r border-border shadow-sm">Final URL</TableHead>
              {isVisible("startDate") && <TableHead className="w-[100px] text-xs">Início gasto</TableHead>}
              {isVisible("age") && <SortHead k="age" label="Idade" />}
              {isVisible("lastAction") && <TableHead className="w-[140px] text-xs">Última ação</TableHead>}
              {isVisible("spend") && <SortHead k="spend" label="Gasto" />}
              {isVisible("revenue") && <SortHead k="revenue" label="Receita" />}
              {isVisible("profit") && <SortHead k="profit" label="Lucro" />}
              {isVisible("roi") && <SortHead k="roi" label="ROI" />}
              {isVisible("roas") && <SortHead k="roas" label="ROAS" />}
              {isVisible("ecpm") && <SortHead k="ecpm" label="eCPM" />}
              {isVisible("impressions") && <SortHead k="impressions" label="Impr." />}
              {isVisible("clicks") && <SortHead k="clicks" label="Cliques" />}
              {isVisible("ctr") && <SortHead k="ctr" label="CTR" />}
              {isVisible("conversions") && <SortHead k="conversions" label="Conv." />}
              {isVisible("convRate") && <SortHead k="convRate" label="Tx. Conv." />}
              {isVisible("cpa") && <SortHead k="cpa" label="CPA" />}
              <TableHead className="w-[320px] text-right pr-6">Ações</TableHead>
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
                  <TableCell className="sticky left-[172px] z-20 w-[260px] min-w-[260px] bg-card border-r border-border font-medium shadow-sm">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        accountDown ? "bg-danger" :
                        c.status === "enabled" ? "bg-success" : isPaused ? "bg-warning" : "bg-muted-foreground"
                      )} />
                      <span className={cn("truncate max-w-[190px]", accountDown && "text-danger")}>{c.name}</span>
                      {accountDown && (
                        <Badge variant="destructive" className="text-[10px] gap-1">
                          <ShieldX className="h-3 w-3" /> Conta suspensa
                        </Badge>
                      )}
                      <RestartStatusBadge flow={restartFlows.data?.get(c.campaign_id)} />
                    </div>
                  </TableCell>
                  <TableCell className="sticky left-[432px] z-20 w-[300px] min-w-[300px] bg-card border-r border-border text-xs shadow-sm">
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
                  <TableCell className="text-right pr-6">
                    <div className="flex justify-end gap-1.5 flex-nowrap">
                      {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={cn(
                              "h-8 px-2",
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

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="outline" className="h-8 px-2 text-xs gap-1">
                                CPA <ChevronDown className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuLabel className="text-xs">Target CPA (ad groups)</DropdownMenuLabel>
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
                            </DropdownMenuContent>
                          </DropdownMenu>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="outline" className="h-8 px-2 text-xs gap-1">
                                Orçamento <ChevronDown className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuLabel className="text-xs">Orçamento da campanha</DropdownMenuLabel>
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
                            </DropdownMenuContent>
                          </DropdownMenu>

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
                  </TableCell>
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
