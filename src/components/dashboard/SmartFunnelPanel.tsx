import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, RefreshCw, Sparkles, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent, fmtNumber } from "@/lib/format";
import { useDashboardFilters } from "@/contexts/FilterContext";
import { cn } from "@/lib/utils";

type FunnelStatus = "learning" | "cpa-learning" | "scaling" | "advanced-scaling" | "stable" | "graduated" | "failed-learning" | "paused";

interface FunnelRow {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  funnel_status: FunnelStatus;
  entry_source: string;
  entered_at: string;
  current_budget: number | null;
  applied_target_cpa: number | null;
  avg_cpa_5d: number | null;
  last_roi_pct: number | null;
  last_delivery_rate: number | null;
  last_action: string | null;
  last_action_reason: string | null;
  last_evaluated_at: string | null;
  next_action_hint: string | null;
  cooldown_scale_until: string | null;
  cooldown_cpa_until: string | null;
  site_id: string | null;
  google_account_id: string | null;
}

interface SiteCfg {
  id: string;
  site_id: string;
  google_account_id: string;
  funnel_enabled: boolean;
  funnel_dry_run: boolean;
  initial_budget: number;
}

interface LogRow {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  action: string;
  reason: string | null;
  status_from: string | null;
  status_to: string | null;
  roi_pct: number | null;
  delivery_rate: number | null;
  avg_cpa: number | null;
  budget_before: number | null;
  budget_after: number | null;
  cpa_before: number | null;
  cpa_after: number | null;
  dry_run: boolean;
  error: string | null;
  created_at: string;
}

const STATUS_META: Record<FunnelStatus, { label: string; cls: string }> = {
  learning: { label: "Aprendendo", cls: "bg-info/10 text-info border-info/30" },
  "cpa-learning": { label: "CPA Learning", cls: "bg-primary/10 text-primary border-primary/30" },
  scaling: { label: "Escalando", cls: "bg-success-soft text-success" },
  "advanced-scaling": { label: "Escala Avançada", cls: "bg-success/20 text-success border-success/40" },
  stable: { label: "Estável", cls: "bg-success/30 text-success" },
  graduated: { label: "Graduada", cls: "bg-muted text-muted-foreground" },
  "failed-learning": { label: "Falhou", cls: "bg-danger-soft text-danger" },
  paused: { label: "Pausada", cls: "bg-warning/10 text-warning border-warning/30" },
};

export function SmartFunnelPanel() {
  const { filters } = useDashboardFilters();
  const selectedAccountIds = filters.googleAccountIds;
  const [localSiteId, setLocalSiteId] = useState<string>("all");
  const selectedSiteId = localSiteId !== "all" ? localSiteId : filters.siteId;
  const [sites, setSites] = useState<{ id: string; name: string; domain: string }[]>([]);
  const [rows, setRows] = useState<FunnelRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [siteCfg, setSiteCfg] = useState<SiteCfg | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [openLogs, setOpenLogs] = useState(false);

  useEffect(() => {
    supabase.from("sites").select("id,name,domain").order("name").then(({ data }) => {
      setSites((data ?? []) as any);
    });
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      let q = supabase.from("campaign_funnel" as any).select("*").order("entered_at", { ascending: false });
      if (selectedSiteId && selectedSiteId !== "all") q = q.eq("site_id", selectedSiteId);
      if (selectedAccountIds.length > 0) q = q.in("google_account_id", selectedAccountIds);
      const { data, error } = await q;
      if (error) throw error;
      setRows((data ?? []) as any);

      // Config do site selecionado
      if (selectedSiteId && selectedSiteId !== "all" && selectedAccountIds.length === 1) {
        const { data: cfg } = await supabase.from("site_funnel_config" as any).select("*")
          .eq("site_id", selectedSiteId)
          .eq("google_account_id", selectedAccountIds[0])
          .maybeSingle();
        setSiteCfg((cfg ?? null) as any);
      } else {
        setSiteCfg(null);
      }

      // Últimos logs
      let lq = supabase.from("campaign_funnel_logs" as any).select("*").order("created_at", { ascending: false }).limit(50);
      if (selectedSiteId && selectedSiteId !== "all") lq = lq.eq("site_id", selectedSiteId);
      const { data: logData } = await lq;
      setLogs((logData ?? []) as any);
    } catch (e) {
      toast({ title: "Erro ao carregar funil", description: String((e as any)?.message ?? e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [selectedSiteId, selectedAccountIds.join(",")]);

  const runNow = async (enrollAll = false) => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("funnel-smart-run", {
        body: {
          force: true,
          enroll_all_created: enrollAll,
          enroll_all: enrollAll,
          onboard_only: enrollAll,
          site_id: selectedSiteId && selectedSiteId !== "all" ? selectedSiteId : undefined,
          google_account_ids: selectedAccountIds,
        },
      });
      if (error) throw error;
      const totals = (data?.summary ?? []).reduce((acc: any, item: any) => ({
        onboarded: acc.onboarded + (Number(item?.onboarded) || 0),
        evaluated: acc.evaluated + (Number(item?.evaluated) || 0),
        actions: acc.actions + (Number(item?.actions) || 0),
      }), { onboarded: 0, evaluated: 0, actions: 0 });
      toast({ title: enrollAll ? "Todas as criadas inscritas no Funil" : "Funil Inteligente executado", description: enrollAll ? `Inscritas: ${totals.onboarded}` : `Avaliadas: ${totals.evaluated} • Ações: ${totals.actions}` });
      await load();
    } catch (e) {
      toast({ title: "Erro ao rodar funil", description: String((e as any)?.message ?? e), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (!selectedSiteId || selectedSiteId === "all" || selectedAccountIds.length !== 1) {
      toast({ title: "Selecione um site e uma conta", variant: "destructive" });
      return;
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const payload = {
      user_id: user.id,
      site_id: selectedSiteId,
      google_account_id: selectedAccountIds[0],
      funnel_enabled: enabled,
      funnel_dry_run: siteCfg?.funnel_dry_run ?? true,
      initial_budget: siteCfg?.initial_budget ?? 30,
    };
    await supabase.from("site_funnel_config" as any).upsert(payload, { onConflict: "user_id,site_id,google_account_id" });
    await load();
  };

  const toggleDryRun = async (dry: boolean) => {
    if (!siteCfg) return;
    await supabase.from("site_funnel_config" as any).update({ funnel_dry_run: dry }).eq("id", siteCfg.id);
    await load();
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.funnel_status] = (c[r.funnel_status] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Funil Inteligente
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Esteira isolada para campanhas novas em Maximizar Conversões. Migra automaticamente para Target CPA e escala progressivamente.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={localSiteId} onValueChange={setLocalSiteId}>
              <SelectTrigger className="h-8 w-[200px] text-xs">
                <SelectValue placeholder="Filtrar por site" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os sites</SelectItem>
                {sites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name || s.domain}</SelectItem>
                ))}
              </SelectContent>
            </Select>
              <>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Esteira</span>
                  <Switch checked={siteCfg.funnel_enabled} onCheckedChange={toggleEnabled} />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Dry-run</span>
                  <Switch checked={siteCfg.funnel_dry_run} onCheckedChange={toggleDryRun} />
                </div>
              </>
            )}
            {!siteCfg && selectedSiteId && selectedSiteId !== "all" && selectedAccountIds.length === 1 && (
              <Button size="sm" variant="outline" onClick={() => toggleEnabled(true)}>Ativar esteira neste site</Button>
            )}
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => runNow(true)} disabled={running} title="Inscreve TODAS as campanhas já criadas desse site/conta no Funil Inteligente">
              Ativar todas criadas
            </Button>
            <Button size="sm" onClick={() => runNow(false)} disabled={running}>
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Play className="h-3.5 w-3.5 mr-1" />}
              Rodar agora
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-3">
          {(Object.keys(STATUS_META) as FunnelStatus[]).map((s) => (
            <Badge key={s} variant="outline" className={cn("text-[10px]", STATUS_META[s].cls)}>
              {STATUS_META[s].label}: {counts[s] ?? 0}
            </Badge>
          ))}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">
            Nenhuma campanha no Funil Inteligente. Campanhas novas (criadas, winners de geo-expansion ou reiniciadas) entram automaticamente quando a esteira estiver ativa para o site.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campanha</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Delivery</TableHead>
                  <TableHead className="text-right">CPA</TableHead>
                  <TableHead className="text-right">Budget</TableHead>
                  <TableHead>Próxima ação</TableHead>
                  <TableHead>Cooldown</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const meta = STATUS_META[r.funnel_status] ?? STATUS_META.learning;
                  const cd = r.cooldown_scale_until && new Date(r.cooldown_scale_until) > new Date()
                    ? `escala até ${new Date(r.cooldown_scale_until).toLocaleDateString("pt-BR")}`
                    : r.cooldown_cpa_until && new Date(r.cooldown_cpa_until) > new Date()
                    ? `CPA até ${new Date(r.cooldown_cpa_until).toLocaleDateString("pt-BR")}`
                    : "—";
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-[260px]">
                        <div className="font-medium text-sm truncate">{r.campaign_name ?? r.campaign_id}</div>
                        <div className="text-[10px] text-muted-foreground">via {r.entry_source} • {new Date(r.entered_at).toLocaleDateString("pt-BR")}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("text-[10px]", meta.cls)}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className={cn(
                          (r.last_roi_pct ?? 0) >= 25 ? "text-success font-semibold"
                          : (r.last_roi_pct ?? 0) >= 0 ? "text-foreground"
                          : "text-danger"
                        )}>
                          {r.last_roi_pct != null ? fmtPercent(r.last_roi_pct) : "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.last_delivery_rate != null ? `${(r.last_delivery_rate * 100).toFixed(0)}%` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.applied_target_cpa ? fmtBRL(r.applied_target_cpa) : (r.avg_cpa_5d ? `~${fmtBRL(r.avg_cpa_5d)}` : "—")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.current_budget ? fmtBRL(r.current_budget) : "—"}
                      </TableCell>
                      <TableCell className="max-w-[280px]">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-xs text-muted-foreground line-clamp-2 cursor-help inline-flex items-center gap-1">
                                {r.next_action_hint ?? r.last_action_reason ?? "—"}
                                {r.last_action_reason && <Info className="h-3 w-3 inline" />}
                              </span>
                            </TooltipTrigger>
                            {r.last_action_reason && (
                              <TooltipContent className="max-w-xs">
                                <div className="text-xs"><b>Última ação:</b> {r.last_action}</div>
                                <div className="text-xs">{r.last_action_reason}</div>
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{cd}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <Collapsible open={openLogs} onOpenChange={setOpenLogs} className="mt-4">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-xs">
              {openLogs ? "Ocultar" : "Ver"} histórico de decisões ({logs.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="overflow-x-auto rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Quando</TableHead>
                    <TableHead className="text-xs">Campanha</TableHead>
                    <TableHead className="text-xs">Ação</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">ROI</TableHead>
                    <TableHead className="text-xs">Deliv.</TableHead>
                    <TableHead className="text-xs">Budget</TableHead>
                    <TableHead className="text-xs">CPA</TableHead>
                    <TableHead className="text-xs">Motivo</TableHead>
                    <TableHead className="text-xs">Modo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-[11px] text-muted-foreground">{new Date(l.created_at).toLocaleString("pt-BR")}</TableCell>
                      <TableCell className="text-xs max-w-[180px] truncate">{l.campaign_name ?? l.campaign_id}</TableCell>
                      <TableCell className="text-xs"><Badge variant="outline" className="text-[10px]">{l.action}</Badge></TableCell>
                      <TableCell className="text-[11px]">{l.status_from ?? "—"} → {l.status_to ?? "—"}</TableCell>
                      <TableCell className="text-xs tabular-nums">{l.roi_pct != null ? fmtPercent(l.roi_pct) : "—"}</TableCell>
                      <TableCell className="text-xs tabular-nums">{l.delivery_rate != null ? `${(l.delivery_rate*100).toFixed(0)}%` : "—"}</TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {l.budget_before != null && l.budget_after != null ? `${fmtBRL(l.budget_before)} → ${fmtBRL(l.budget_after)}` : "—"}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {l.cpa_before != null && l.cpa_after != null ? `${fmtBRL(l.cpa_before)} → ${fmtBRL(l.cpa_after)}` : (l.avg_cpa != null ? fmtBRL(l.avg_cpa) : "—")}
                      </TableCell>
                      <TableCell className="text-[11px] max-w-[260px]">{l.reason ?? "—"}{l.error && <span className="text-danger block">erro: {l.error}</span>}</TableCell>
                      <TableCell className="text-[10px]">{l.dry_run ? "simulação" : "real"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
