import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Rocket, Sparkles, Play, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent } from "@/lib/format";
import { useDashboardFilters } from "@/contexts/FilterContext";

interface Winner {
  campaign_id: string;
  campaign_name: string;
  google_account_id: string;
  country_code: string;
  country_name: string;
  country_criterion_id: string | null;
  cost_brl: number;
  revenue_brl: number;
  roi_pct: number;
  campaign_cost_brl: number;
  countries_in_campaign: number;
  budget_micros: number | null;
}

interface GeoExpansionStats {
  period?: { from: string; to: string };
  total?: number;
  candidates_total?: number;
  rejection_counts?: Record<string, number>;
  top_candidates?: (Winner & { reject_reasons?: string[] })[];
}

interface CreatedLog {
  id: string;
  original_campaign_id: string;
  original_campaign_name: string | null;
  new_campaign_id: string | null;
  new_campaign_name: string | null;
  country_code: string;
  country_name: string | null;
  roi_pct: number | null;
  cost_brl: number | null;
  revenue_brl: number | null;
  budget_micros: number | null;
  status: string;
  executed_at: string;
  google_account_id: string | null;
  live_status?: string | null;
}

interface SiteOption {
  id: string;
  name: string;
}

async function fetchDashboardCampaignIds(siteId: string, accountIds: string[], from: string, to: string) {
  const campaignIds = new Set<string>();
  let start = 0;
  for (;;) {
    const { data } = await supabase
      .from("campaigns")
      .select("campaign_id, google_account_id")
      .in("google_account_id", accountIds)
      .range(start, start + 999);
    const rows = data ?? [];
    for (const r of rows) if (r.campaign_id) campaignIds.add(String(r.campaign_id));
    if (rows.length < 1000) break;
    start += 1000;
  }
  if (campaignIds.size === 0) return [];

  const metricByCampaign = new Map<string, { spend: number; revenue: number }>();
  for (const chunk of chunkArr([...campaignIds], 200)) {
    let mStart = 0;
    for (;;) {
      const { data } = await supabase
        .from("daily_metrics")
        .select("campaign_id, spend, revenue")
        .in("campaign_id", chunk)
        .in("google_account_id", accountIds)
        .gte("date", from)
        .lte("date", to)
        .range(mStart, mStart + 999);
      const rows = data ?? [];
      for (const r of rows) {
        const cid = String(r.campaign_id);
        const current = metricByCampaign.get(cid) ?? { spend: 0, revenue: 0 };
        current.spend += Number(r.spend) || 0;
        current.revenue += Number(r.revenue) || 0;
        metricByCampaign.set(cid, current);
      }
      if (rows.length < 1000) break;
      mStart += 1000;
    }
  }

  const shareByCampaign = new Map<string, Map<string, number>>();
  const metricIds = [...metricByCampaign.keys()];
  for (const chunk of chunkArr(metricIds, 200)) {
    let rStart = 0;
    const total = new Map<string, number>();
    const bySite = new Map<string, Map<string, number>>();
    for (;;) {
      const { data } = await supabase
        .from("gam_placement_revenue")
        .select("campaign_id, site_id, revenue_usd")
        .not("site_id", "is", null)
        .neq("campaign_id", "__aggregate__")
        .in("campaign_id", chunk)
        .gte("date", from)
        .lte("date", to)
        .range(rStart, rStart + 999);
      const rows = data ?? [];
      for (const r of rows) {
        const cid = String(r.campaign_id);
        const sid = String(r.site_id);
        const rev = Number(r.revenue_usd) || 0;
        total.set(cid, (total.get(cid) ?? 0) + rev);
        const inner = bySite.get(cid) ?? new Map<string, number>();
        inner.set(sid, (inner.get(sid) ?? 0) + rev);
        bySite.set(cid, inner);
      }
      if (rows.length < 1000) break;
      rStart += 1000;
    }
    for (const [cid, inner] of bySite) {
      const sum = total.get(cid) ?? 0;
      if (sum <= 0) continue;
      const pct = new Map<string, number>();
      for (const [sid, rev] of inner) pct.set(sid, rev / sum);
      shareByCampaign.set(cid, pct);
    }
  }

  return metricIds.filter((cid) => {
    const metric = metricByCampaign.get(cid);
    if (!metric || (metric.spend <= 0 && metric.revenue <= 0)) return false;
    const share = shareByCampaign.get(cid);
    const factor = !share || share.size <= 1 ? 1 : share.get(siteId) ?? 0;
    return factor > 0;
  });
}

export function GeoExpansionPanel({ siteId }: { siteId: string | null }) {
  const { filters } = useDashboardFilters();
  const [loading, setLoading] = useState(false);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [items, setItems] = useState<Winner[]>([]);
  const [stats, setStats] = useState<GeoExpansionStats | null>(null);
  const [created, setCreated] = useState<CreatedLog[]>([]);
  const [loadingCreated, setLoadingCreated] = useState(false);
  const [tab, setTab] = useState<"winners" | "created">("winners");
  const [enabled, setEnabled] = useState(false);
  const [minRoi, setMinRoi] = useState(25);
  const [minCampCost, setMinCampCost] = useState(500);
  const [minCountryCost, setMinCountryCost] = useState(100);
  const [minCountries, setMinCountries] = useState(3);
  const [lookback, setLookback] = useState(7);
  const [interval, setIntervalDays] = useState(7);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [analysisSiteId, setAnalysisSiteId] = useState<string>(siteId ?? "all");
  const activeSiteId = analysisSiteId !== "all" ? analysisSiteId : null;

  useEffect(() => { setAnalysisSiteId(siteId ?? "all"); }, [siteId]);

  useEffect(() => {
    supabase.from("sites").select("id, name").order("name").then(({ data }) => {
      setSites((data ?? []) as SiteOption[]);
    });
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("rules_config")
        .select("geo_expansion_enabled, geo_expansion_min_roi_pct, geo_expansion_min_campaign_cost_brl, geo_expansion_min_country_cost_brl, geo_expansion_min_countries, geo_expansion_lookback_days, geo_expansion_interval_days, geo_expansion_budget_multiplier, geo_expansion_last_run_at")
        .maybeSingle();
      if (data) {
        setEnabled(!!data.geo_expansion_enabled);
        setMinRoi(Number(data.geo_expansion_min_roi_pct ?? 25));
        setMinCampCost(Number(data.geo_expansion_min_campaign_cost_brl ?? 500));
        setMinCountryCost(Number(data.geo_expansion_min_country_cost_brl ?? 100));
        setMinCountries(Number(data.geo_expansion_min_countries ?? 3));
        setLookback(Number(data.geo_expansion_lookback_days ?? 7));
        setIntervalDays(Number(data.geo_expansion_interval_days ?? 7));
        setLastRun(data.geo_expansion_last_run_at ?? null);
      }
    })();
  }, []);

  const loadCreated = useCallback(async () => {
    if (!activeSiteId) { setCreated([]); return; }
    setLoadingCreated(true);
    try {
      const q = (supabase.from("campaign_expansion_logs") as any)
        .select("id, original_campaign_id, original_campaign_name, new_campaign_id, new_campaign_name, country_code, country_name, roi_pct, cost_brl, revenue_brl, budget_micros, status, executed_at, google_account_id")
        .eq("action", "created")
        .eq("site_id", activeSiteId)
        .order("executed_at", { ascending: false })
        .limit(100);
      const { data } = await q;
      const logs = (data ?? []) as (CreatedLog & { google_account_id: string | null })[];

      // Fetch live status from campaigns table
      const newIds = logs.map((l) => l.new_campaign_id).filter((x): x is string => !!x);
      const liveStatus: Record<string, string> = {};
      if (newIds.length > 0) {
        const { data: campRows } = await supabase
          .from("campaigns")
          .select("campaign_id, status")
          .in("campaign_id", newIds);
        for (const r of campRows ?? []) liveStatus[String(r.campaign_id)] = String(r.status);
      }
      setCreated(logs.map((l) => ({ ...l, live_status: l.new_campaign_id ? liveStatus[l.new_campaign_id] ?? null : null })));
    } finally { setLoadingCreated(false); }
  }, [activeSiteId]);

  useEffect(() => { loadCreated(); }, [loadCreated]);

  const persist = async (patch: Record<string, unknown>) => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await (supabase.from("rules_config") as any).update(patch).eq("user_id", u.user.id);
  };

  const loadPreview = async () => {
    if (!activeSiteId) {
      toast({ title: "Selecione um site", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const today = new Date();
      const toDate = new Date(today.getTime() - 86400_000);
      const fromDate = new Date(today.getTime() - lookback * 86400_000);
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const { data: links, error: linksError } = await supabase
        .from("account_site_links")
        .select("google_account_id")
        .eq("site_id", activeSiteId);
      if (linksError) {
        toast({ title: "Erro ao puxar contas", description: linksError.message, variant: "destructive" });
        return;
      }
      const accountIds = [...new Set((links ?? []).map((l) => String(l.google_account_id)).filter(Boolean))];
      if (accountIds.length === 0) {
        toast({ title: "Sem contas vinculadas", description: "Este site não tem contas Ads vinculadas.", variant: "destructive" });
        return;
      }
      const { data: campaignSyncData, error: campaignSyncError } = await supabase.functions.invoke("google-ads-sync-campaigns", {
        body: { account_ids: accountIds, from: iso(fromDate), to: iso(toDate) },
      });
      if (campaignSyncError || (campaignSyncData as any)?.error) {
        toast({ title: "Erro ao puxar campanhas", description: (campaignSyncData as any)?.error ?? campaignSyncError?.message, variant: "destructive" });
        return;
      }
      const { data: syncData, error: syncError } = await supabase.functions.invoke("google-ads-sync-countries", {
        body: { site_id: activeSiteId, lookback_days: lookback },
      });
      if (syncError || (syncData as any)?.error) {
        toast({ title: "Erro ao puxar países", description: (syncData as any)?.error ?? syncError?.message, variant: "destructive" });
        return;
      }
      const { data, error } = await supabase.functions.invoke("geo-expansion", {
        body: {
          mode: "preview",
          site_id: activeSiteId,
          min_roi_pct: minRoi,
          min_campaign_cost_brl: minCampCost,
          min_country_cost_brl: minCountryCost,
          min_countries: minCountries,
          lookback_days: lookback,
        },
      });
      if (error || (data as any)?.error) {
        toast({ title: "Erro", description: (data as any)?.error ?? error?.message, variant: "destructive" });
        return;
      }
      setItems(((data as any)?.items ?? []) as Winner[]);
      setStats(((data as any)?.stats ?? null) as GeoExpansionStats | null);
    } finally { setLoading(false); }
  };

  const createOne = async (it: Winner) => {
    if (!activeSiteId) {
      toast({ title: "Selecione um site", variant: "destructive" });
      return;
    }
    const k = `${it.campaign_id}|${it.country_code}`;
    setCreatingKey(k);
    try {
      const { data, error } = await supabase.functions.invoke("geo-expansion", {
        body: {
          mode: "apply",
          site_id: activeSiteId,
          start_status: "PAUSED",
          item: it,
        },
      });
      if (error || (data as any)?.error) {
        const dbg = (data as any)?.debug;
        if (dbg) console.error("[geo-expansion] debug:", dbg);
        const desc = (data as any)?.error ?? error?.message;
        toast({
          title: "Falha ao duplicar",
          description: dbg ? `${desc} — detalhes no console (F12)` : desc,
          variant: "destructive",
        });
        return;
      }
      const dbg = (data as any)?.debug;
      if (dbg) console.info("[geo-expansion] clone debug:", dbg);
      const devices = ((data as any)?.active_devices ?? dbg?.cloned?.active_devices ?? []).join("/") || "dispositivos copiados";
      toast({
        title: "Campanha criada (PAUSED)",
        description: `${(data as any)?.new_campaign_name} • ${(data as any)?.ad_groups_cloned} ad groups • ${(data as any)?.ads_cloned} ads • ${(data as any)?.assets_cloned ?? 0} assets • ${devices}`,
      });
      setItems((s) => s.filter((x) => `${x.campaign_id}|${x.country_code}` !== k));
      await loadCreated();
      setTab("created");
    } finally { setCreatingKey(null); }
  };

  const createAll = async () => {
    if (!activeSiteId) {
      toast({ title: "Selecione um site", variant: "destructive" });
      return;
    }
    if (items.length === 0) return;
    setBulkCreating(true);
    let ok = 0; let fail = 0;
    try {
      for (const it of items) {
        try {
          const { data } = await supabase.functions.invoke("geo-expansion", {
            body: { mode: "apply", site_id: activeSiteId, start_status: "PAUSED", item: it },
          });
          if ((data as any)?.debug) console.info("[geo-expansion] clone debug:", (data as any).debug);
          if ((data as any)?.ok) ok++; else fail++;
        } catch { fail++; }
      }
      toast({ title: "Expansão concluída", description: `${ok} criadas, ${fail} falharam.` });
      await loadPreview();
      await loadCreated();
      if (ok > 0) setTab("created");
    } finally { setBulkCreating(false); }
  };

  const [activatingId, setActivatingId] = useState<string | null>(null);
  const activateCampaign = async (c: CreatedLog) => {
    if (!c.new_campaign_id || !c.google_account_id) return;
    setActivatingId(c.id);
    try {
      const { data, error } = await supabase.functions.invoke("google-ads-mutate", {
        body: { action: "set_status", campaign_id: c.new_campaign_id, google_account_id: c.google_account_id, status: "ENABLED" },
      });
      if (error || (data as any)?.error) {
        toast({ title: "Falha ao ativar", description: (data as any)?.error ?? error?.message, variant: "destructive" });
        return;
      }
      toast({ title: "Campanha ativada", description: c.new_campaign_name ?? c.new_campaign_id });
      await loadCreated();
    } finally { setActivatingId(null); }
  };

  const summary = useMemo(() => {
    const totalCost = items.reduce((s, i) => s + i.cost_brl, 0);
    const totalRev = items.reduce((s, i) => s + i.revenue_brl, 0);
    const avgRoi = items.length > 0 ? items.reduce((s, i) => s + i.roi_pct, 0) / items.length : 0;
    return { totalCost, totalRev, avgRoi };
  }, [items]);

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-elegant space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <Rocket className="h-4 w-4 text-primary" /> Expansão automática por país vencedor
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Identifica países lucrativos dentro de campanhas multi-geo e duplica a campanha focada apenas
            nesse país (criada PAUSED). Cron a cada {interval} dia(s){lastRun ? ` • último: ${new Date(lastRun).toLocaleString("pt-BR")}` : ""}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Cron automático</span>
          <Switch
            checked={enabled}
            onCheckedChange={async (v) => { setEnabled(v); await persist({ geo_expansion_enabled: v }); }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Site para análise</label>
          <Select value={analysisSiteId} onValueChange={(v) => { setAnalysisSiteId(v); setItems([]); }}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Selecione um site</SelectItem>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Field label="ROI mín. (%)" value={minRoi} onBlur={(v) => { setMinRoi(v); persist({ geo_expansion_min_roi_pct: v }); }} />
        <Field label="Custo mín. campanha (R$)" value={minCampCost} onBlur={(v) => { setMinCampCost(v); persist({ geo_expansion_min_campaign_cost_brl: v }); }} />
        <Field label="Custo mín. país (R$)" value={minCountryCost} onBlur={(v) => { setMinCountryCost(v); persist({ geo_expansion_min_country_cost_brl: v }); }} />
        <Field label="Mín. países" value={minCountries} onBlur={(v) => { setMinCountries(v); persist({ geo_expansion_min_countries: v }); }} />
        <Field label="Janela (dias)" value={lookback} onBlur={(v) => { setLookback(v); persist({ geo_expansion_lookback_days: v }); }} />
        <Field label="Intervalo cron (dias)" value={interval} onBlur={(v) => { setIntervalDays(v); persist({ geo_expansion_interval_days: v }); }} />
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        <button
          onClick={() => setTab("winners")}
          className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === "winners" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          <Sparkles className="h-3.5 w-3.5 inline mr-1.5" />
          Winners ({items.length})
        </button>
        <button
          onClick={() => setTab("created")}
          className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === "created" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          <CheckCircle2 className="h-3.5 w-3.5 inline mr-1.5" />
          Criadas ({created.length})
        </button>
      </div>

      {tab === "winners" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={loadPreview} disabled={loading || !activeSiteId} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Buscar países vencedores
            </Button>
            {items.length > 0 && (
              <Button onClick={createAll} disabled={bulkCreating} variant="default" className="gap-2">
                {bulkCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Criar todas ({items.length})
              </Button>
            )}
            {items.length > 0 && (
              <div className="text-xs text-muted-foreground ml-auto">
                {items.length} winner(s) • custo {fmtBRL(summary.totalCost)} • receita {fmtBRL(summary.totalRev)} • ROI médio {fmtPercent(summary.avgRoi)}
              </div>
            )}
            {items.length === 0 && stats?.candidates_total ? (
              <div className="text-xs text-muted-foreground ml-auto">
                {stats.candidates_total} candidato(s) analisados • nenhum passou em todos os filtros
              </div>
            ) : null}
          </div>

          {items.length > 0 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campanha origem</TableHead>
                    <TableHead>País</TableHead>
                    <TableHead className="text-right">Custo</TableHead>
                    <TableHead className="text-right">Receita</TableHead>
                    <TableHead className="text-right">ROI</TableHead>
                    <TableHead className="text-right">Países</TableHead>
                    <TableHead className="text-right">Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => {
                    const k = `${it.campaign_id}|${it.country_code}`;
                    return (
                      <TableRow key={k}>
                        <TableCell className="font-medium max-w-[320px] truncate">{it.campaign_name}</TableCell>
                        <TableCell>
                          <span className="font-mono text-xs">{it.country_code}</span>
                          {it.country_name && <span className="ml-1.5 text-muted-foreground text-xs">{it.country_name}</span>}
                        </TableCell>
                        <TableCell className="text-right">{fmtBRL(it.cost_brl)}</TableCell>
                        <TableCell className="text-right">{fmtBRL(it.revenue_brl)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant="default">{fmtPercent(it.roi_pct)}</Badge>
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{it.countries_in_campaign}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm" variant="outline"
                            onClick={() => createOne(it)}
                            disabled={creatingKey === k || !it.country_criterion_id}
                            className="gap-1.5"
                          >
                            {creatingKey === k ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                            Criar campanha
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {items.length === 0 && !loading && (
            <div className="space-y-3 py-4">
              <p className="text-xs text-muted-foreground text-center">
                Nenhum winner identificado ainda. Clique em "Buscar países vencedores" para analisar.
              </p>
              {stats?.top_candidates && stats.top_candidates.length > 0 && (
                <div className="rounded-lg border border-border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Quase winner</TableHead>
                        <TableHead>País</TableHead>
                        <TableHead className="text-right">Custo</TableHead>
                        <TableHead className="text-right">Receita</TableHead>
                        <TableHead className="text-right">ROI</TableHead>
                        <TableHead>Motivo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stats.top_candidates.map((it) => (
                        <TableRow key={`${it.campaign_id}|${it.country_code}|debug`}>
                          <TableCell className="font-medium max-w-[260px] truncate text-xs">{it.campaign_name}</TableCell>
                          <TableCell className="text-xs"><span className="font-mono">{it.country_code}</span> {it.country_name}</TableCell>
                          <TableCell className="text-right text-xs">{fmtBRL(it.cost_brl)}</TableCell>
                          <TableCell className="text-right text-xs">{fmtBRL(it.revenue_brl)}</TableCell>
                          <TableCell className="text-right text-xs">{fmtPercent(it.roi_pct)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{it.reject_reasons?.join(" • ") ?? "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === "created" && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={loadCreated} disabled={loadingCreated} variant="outline" size="sm" className="gap-2">
              {loadingCreated ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Atualizar
            </Button>
            <span className="text-xs text-muted-foreground ml-auto">
              Histórico de winners duplicadas. Clique em <strong>Ativar</strong> para ligar uma campanha pausada.
            </span>
          </div>

          {created.length > 0 ? (
            <div className="rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Origem</TableHead>
                    <TableHead>Nova campanha (winner)</TableHead>
                    <TableHead>País</TableHead>
                    <TableHead className="text-right">ROI</TableHead>
                    <TableHead className="text-right">Custo origem</TableHead>
                    <TableHead className="text-right">Budget novo</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {created.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(c.executed_at).toLocaleString("pt-BR")}
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate text-xs">{c.original_campaign_name ?? c.original_campaign_id}</TableCell>
                      <TableCell className="max-w-[280px] truncate font-medium text-xs">{c.new_campaign_name ?? "—"}</TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{c.country_code}</span>
                        {c.country_name && <span className="ml-1.5 text-muted-foreground text-xs">{c.country_name}</span>}
                      </TableCell>
                      <TableCell className="text-right">{c.roi_pct != null ? fmtPercent(c.roi_pct) : "—"}</TableCell>
                      <TableCell className="text-right text-xs">{c.cost_brl != null ? fmtBRL(c.cost_brl) : "—"}</TableCell>
                      <TableCell className="text-right text-xs">{c.budget_micros ? fmtBRL(Number(c.budget_micros) / 1_000_000) : "—"}</TableCell>
                      <TableCell>
                        {c.live_status === "enabled" ? (
                          <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-600">ATIVA</Badge>
                        ) : c.live_status === "paused" ? (
                          <Badge variant="secondary">PAUSED</Badge>
                        ) : (
                          <Badge variant="outline">{c.live_status ?? c.status}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.live_status !== "enabled" && c.new_campaign_id && c.google_account_id ? (
                          <Button
                            size="sm" variant="default"
                            onClick={() => activateCampaign(c)}
                            disabled={activatingId === c.id}
                            className="gap-1.5"
                          >
                            {activatingId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            Ativar
                          </Button>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">
              Nenhuma campanha winner criada ainda{siteId ? " neste site" : ""}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Field({ label, value, step = 1, onBlur }: { label: string; value: number; step?: number; onBlur: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <Input
        type="number" step={step} value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { const n = Number(v); if (Number.isFinite(n)) onBlur(n); }}
        className="mt-1 h-8"
      />
    </label>
  );
}
