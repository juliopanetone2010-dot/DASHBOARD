import { useMemo, useState } from "react";
import { Pause, Play, TrendingUp, ChevronDown, ChevronUp, ChevronsUpDown, Loader2, ShieldX, ExternalLink, Copy } from "lucide-react";
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
  // Padrão: ROI DESC. null = sem ordenação (ordem original)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>({ key: "roi", dir: "desc" });

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

  const SortHead = ({ k, label }: { k: SortKey; label: string }) => {
    const active = sort?.key === k;
    return (
      <TableHead className={cn("text-right", active && "bg-primary/5")}>
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

  return (
    <TooltipProvider delayDuration={150}>
    <div className="rounded-xl border border-border bg-card shadow-elegant overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="w-[120px]">Campaign ID</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead className="w-[220px]">Final URL</TableHead>
              <TableHead className="w-[100px] text-xs">Início gasto</TableHead>
              <SortHead k="age" label="Idade" />
              <TableHead className="w-[140px] text-xs">Última ação</TableHead>
              <SortHead k="spend" label="Gasto" />
              <SortHead k="revenue" label="Receita" />
              <SortHead k="profit" label="Lucro" />
              <SortHead k="roi" label="ROI" />
              <SortHead k="roas" label="ROAS" />
              <SortHead k="ecpm" label="eCPM" />
              <SortHead k="impressions" label="Impr." />
              <SortHead k="clicks" label="Cliques" />
              <SortHead k="ctr" label="CTR" />
              <SortHead k="conversions" label="Conv." />
              <SortHead k="convRate" label="Tx. Conv." />
              <SortHead k="cpa" label="CPA" />
              <TableHead className="w-[320px] text-right pr-6">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedCampaigns.length === 0 && (
              <TableRow>
                <TableCell colSpan={19} className="text-center text-muted-foreground py-10">
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
                <TableRow key={c.campaign_id} className={cn("group", accountDown && "bg-danger-soft/20")}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {c.campaign_id}
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        accountDown ? "bg-danger" :
                        c.status === "enabled" ? "bg-success" : isPaused ? "bg-warning" : "bg-muted-foreground"
                      )} />
                      <span className={cn("truncate max-w-[240px]", accountDown && "text-danger")}>{c.name}</span>
                      {accountDown && (
                        <Badge variant="destructive" className="text-[10px] gap-1">
                          <ShieldX className="h-3 w-3" /> Conta suspensa
                        </Badge>
                      )}
                      <RestartStatusBadge flow={restartFlows.data?.get(c.campaign_id)} />
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {finalUrl ? (
                      <div className="flex items-center gap-1 max-w-[220px]">
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
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {firstSpend ? firstSpend.slice(5).replace("-", "/") : "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {age != null ? <span className="font-semibold">{age}d</span> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-xs">
                    {lastAction ? (
                      <div className="flex flex-col leading-tight">
                        <span className="font-medium truncate max-w-[140px]" title={lastAction.label}>{lastAction.label}</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">{lastAction.date.slice(0, 10)}</span>
                      </div>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtCurrency(c.spend)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <div>{fmtUSD(c.revenue)}</div>
                    {c.revenue_brl != null && (
                      <div className="text-[10px] text-muted-foreground">
                        ≈ {fmtCurrency(c.revenue_brl)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-semibold tabular-nums",
                      positive ? "text-success" : "text-danger",
                    )}
                  >
                    {fmtCurrency(c.profit)}
                  </TableCell>
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
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {(Number(c.roas) || 0).toFixed(2)}x
                  </TableCell>
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
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    <div>{fmtNumber(gamMetric?.impressions ?? c.impressions)}</div>
                    {gamMetric && <div className="text-[10px] text-muted-foreground">GAM</div>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtNumber(c.clicks)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {(d?.ctr ?? 0).toFixed(2)}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtNumber(Math.round(c.conversions))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {(d?.convRate ?? 0).toFixed(2)}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {c.conversions > 0 ? fmtCurrency(d?.cpa ?? 0) : "—"}
                  </TableCell>
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
