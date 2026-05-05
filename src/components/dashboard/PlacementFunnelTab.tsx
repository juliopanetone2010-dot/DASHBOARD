import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Play, Ban, RotateCcw, Sparkles, Filter, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { NET_FACTOR } from "@/engine/rules";
import { CleanupImpactPanel } from "./CleanupImpactPanel";
import { useDashboardFilters } from "@/contexts/FilterContext";

interface Props { fxUsdBrl: number; }

type Status = "test" | "learning" | "good" | "bad" | "blocked";

interface Row {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
  google_account_id: string | null;
  site_id: string | null;
  site_scope?: string | null;
  placement: string;
  placement_type: string | null;
  status: Status;
  phase: string;
  reason: string | null;
  priority: boolean;
  manual_override: boolean;
  cost_total: number;
  revenue_total: number;
  profit_total: number;
  roi_pct: number;
  clicks_total: number;
  impressions_total: number;
  conversions_total: number;
  first_seen_at: string;
  last_evaluated_at: string;
  last_status_change_at: string;
}

interface AccountOpt { id: string; name: string; }
interface SiteOpt { id: string; name: string; account_ids: string[]; }
interface CampaignOpt { campaign_id: string; name: string; google_account_id: string | null; }
interface CampaignMetricSummary { campaign_id: string; name: string; google_account_id: string | null; cost: number; rev: number; profit: number; roi: number; }

const isoLocal = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const rangeFromLookback = (lookback: number) => {
  const today = new Date();
  if (lookback === 1) return { from: isoLocal(today), to: isoLocal(today) };
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (lookback === 2) return { from: isoLocal(yesterday), to: isoLocal(yesterday) };
  const from = new Date(today);
  from.setDate(today.getDate() - Math.max(1, lookback));
  return { from: isoLocal(from), to: isoLocal(yesterday) };
};

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  test: { label: "Teste", cls: "bg-muted text-muted-foreground" },
  learning: { label: "Aprendendo", cls: "bg-info/10 text-info border-info/30" },
  good: { label: "Bom", cls: "bg-success-soft text-success" },
  bad: { label: "Ruim", cls: "bg-warning/10 text-warning border-warning/30" },
  blocked: { label: "Bloqueado", cls: "bg-danger-soft text-danger" },
};

export function PlacementFunnelTab({ fxUsdBrl }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lookback, setLookback] = useState(15);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoIntervalDays, setAutoIntervalDays] = useState(15);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [sites, setSites] = useState<SiteOpt[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOpt[]>([]);
  const [campaignMetrics, setCampaignMetrics] = useState<CampaignMetricSummary[]>([]);
  const [accountFilter, setAccountFilter] = useState<Set<string>>(new Set()); // empty = all
  const [siteFilter, setSiteFilter] = useState<Set<string>>(new Set()); // empty = all
  const { filters: dashboardFilters } = useDashboardFilters();

  useEffect(() => {
    setSiteFilter((prev) => {
      if (dashboardFilters.siteId === "all") return prev.size === 0 ? prev : new Set();
      return prev.size === 1 && prev.has(dashboardFilters.siteId) ? prev : new Set([dashboardFilters.siteId]);
    });
  }, [dashboardFilters.siteId]);

  const loadConfig = async () => {
    const { data } = await supabase
      .from("rules_config")
      .select("funnel_auto_enabled, funnel_auto_last_run_at, funnel_auto_interval_days")
      .maybeSingle();
    if (data) {
      setAutoEnabled(!!(data as any).funnel_auto_enabled);
      setLastRun((data as any).funnel_auto_last_run_at ?? null);
      setAutoIntervalDays(Number((data as any).funnel_auto_interval_days ?? 15));
    }
    const [{ data: accs }, { data: siteRows }, { data: linkRows }, { data: campRows }] = await Promise.all([
      supabase.from("google_accounts").select("id, account_name, descriptive_name, customer_id").order("account_name", { ascending: true }),
      supabase.from("sites").select("id, name").order("name", { ascending: true }),
      supabase.from("account_site_links").select("site_id, google_account_id"),
      supabase.from("campaigns").select("campaign_id, name, google_account_id"),
    ]);
    setAccounts((accs ?? []).map((a: any) => ({ id: a.id, name: a.account_name || a.descriptive_name || a.customer_id })));
    const linksBySite = new Map<string, string[]>();
    for (const l of linkRows ?? []) {
      const arr = linksBySite.get(l.site_id) ?? [];
      arr.push(l.google_account_id);
      linksBySite.set(l.site_id, arr);
    }
    setSites((siteRows ?? []).map((s: any) => ({ id: s.id, name: s.name, account_ids: linksBySite.get(s.id) ?? [] })));
    setCampaigns((campRows ?? []).map((c: any) => ({ campaign_id: String(c.campaign_id), name: c.name, google_account_id: c.google_account_id ?? null })));
  };

  const load = async () => {
    setLoading(true);
    try {
      const all: Row[] = [];
      let s = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("placement_status")
          .select("id, campaign_id, campaign_name, google_account_id, site_id, site_scope, placement, placement_type, status, phase, reason, priority, manual_override, cost_total, revenue_total, profit_total, roi_pct, clicks_total, impressions_total, conversions_total, first_seen_at, last_evaluated_at, last_status_change_at")
          .order("cost_total", { ascending: false })
          .range(s, s + 999);
        if (error) throw error;
        const rows = (data ?? []) as Row[];
        all.push(...rows);
        if (rows.length < 1000) break;
        s += 1000;
      }
      // Mantém o último ciclo POR SITE (em vez de um único max global), senão sites
      // avaliados há mais tempo somem da esteira mesmo tendo placements bloqueados.
      const latestBySite = new Map<string, number>();
      for (const r of all) {
        const k = r.site_id ?? "__none__";
        const t = new Date(r.last_evaluated_at ?? 0).getTime();
        if (t > (latestBySite.get(k) ?? 0)) latestBySite.set(k, t);
      }
      const latestCycleRows = all.filter((r) => {
        const k = r.site_id ?? "__none__";
        const latest = latestBySite.get(k) ?? 0;
        if (latest === 0) return true;
        return latest - new Date(r.last_evaluated_at ?? 0).getTime() <= 10 * 60_000;
      });
      setRows(latestCycleRows);
      const { from, to } = rangeFromLookback(lookback);
      const campMap = new Map(campaigns.map((c) => [c.campaign_id, c]));

      // Mapa real site → campanhas, vindo da receita GAM atribuída por UTM.
      // Necessário quando vários sites usam a mesma conta Google Ads: filtrar só por conta mistura sites.
      const { data: attributionRows } = await supabase
        .from("gam_placement_revenue")
        .select("site_id, campaign_id")
        .not("site_id", "is", null)
        .gte("date", from)
        .lte("date", to)
        .limit(50000);
      const localSiteCampaignIds = new Map<string, Set<string>>();
      for (const r of attributionRows ?? []) {
        const sid = String((r as any).site_id ?? "");
        const cid = String((r as any).campaign_id ?? "");
        if (!sid || !cid || cid === "__aggregate__") continue;
        const set = localSiteCampaignIds.get(sid) ?? new Set<string>();
        set.add(cid);
        localSiteCampaignIds.set(sid, set);
      }
      // Calcula contas permitidas (mesmo filtro do display) para bater com a dashboard
      let allowed: Set<string> | null = null;
      if (accountFilter.size > 0) allowed = new Set(accountFilter);
      if (siteFilter.size > 0) {
        const fromSites = new Set<string>();
        for (const st of sites) if (siteFilter.has(st.id)) for (const a of st.account_ids) fromSites.add(a);
        allowed = allowed ? new Set([...allowed].filter((a) => fromSites.has(a))) : fromSites;
      }
      const allowedCampaigns = new Set<string>();
      if (siteFilter.size > 0) {
        for (const sid of siteFilter) for (const cid of localSiteCampaignIds.get(sid) ?? []) allowedCampaigns.add(cid);
      }

      const metrics: any[] = [];
      let m = 0;
      for (;;) {
        let q = supabase
          .from("daily_metrics")
          .select("campaign_id, google_account_id, spend, revenue, profit")
          .gte("date", from)
          .lte("date", to);
        if (allowed && allowed.size > 0) q = q.in("google_account_id", [...allowed]);
        if (siteFilter.size > 0) {
          q = allowedCampaigns.size > 0
            ? q.in("campaign_id", [...allowedCampaigns])
            : q.eq("campaign_id", "__no_site_campaign__");
        }
        const { data, error } = await q.range(m, m + 999);
        if (error) throw error;
        const page = data ?? [];
        metrics.push(...page);
        if (page.length < 1000) break;
        m += 1000;
      }
      // Mesma fórmula da dashboard (engine/rules.ts aggregateByCampaign):
      // grossRevBrl = profit + spend ; revenue_brl_net = grossRevBrl * NET_FACTOR
      // profit_net  = profit - grossRevBrl * REV_SHARE
      const byCampaign = new Map<string, CampaignMetricSummary & { grossRevBrl: number }>();
      for (const r of metrics) {
        const cid = String(r.campaign_id);
        const c = campMap.get(cid);
        const cur = byCampaign.get(cid) ?? { campaign_id: cid, name: c?.name ?? cid, google_account_id: c?.google_account_id ?? null, cost: 0, rev: 0, profit: 0, roi: 0, grossRevBrl: 0 };
        const spend = Number(r.spend ?? 0);
        const grossProfit = Number(r.profit ?? 0);
        cur.cost += spend;
        cur.grossRevBrl += spend + grossProfit;
        byCampaign.set(cid, cur);
      }
      for (const c of byCampaign.values()) {
        c.rev = c.grossRevBrl * NET_FACTOR;
        c.profit = c.rev - c.cost;
        c.roi = c.cost > 0 ? (c.profit / c.cost) * 100 : 0;
      }
      setCampaignMetrics([...byCampaign.values()]);
    } catch (e: any) {
      toast({ title: "Erro ao carregar", description: e.message, variant: "destructive" });
    } finally { setLoading(false); }
  };

  useEffect(() => { loadConfig(); }, []);
  useEffect(() => { load(); }, [lookback, campaigns.length, accountFilter, siteFilter, sites]);

  const toggleAuto = async (on: boolean) => {
    setAutoEnabled(on);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase.from("rules_config").update({ funnel_auto_enabled: on } as any).eq("user_id", u.user.id);
    toast({ title: on ? `Esteira automática ligada (a cada ${autoIntervalDays}d)` : "Esteira automática desligada" });
  };

  const updateAutoInterval = async (days: number) => {
    const v = Math.max(1, Math.min(180, Math.round(days)));
    setAutoIntervalDays(v);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase.from("rules_config")
      .update({ funnel_auto_interval_days: v } as any)
      .eq("user_id", u.user.id);
  };

  const evaluateNow = async () => {
    setEvaluating(true);
    try {
      // Mesma janela da Dashboard: Hoje é hoje; Ontem é ontem; últimos N dias são dias completos até ontem.
      const { from, to } = rangeFromLookback(lookback);
      const selectedSiteId = siteFilter.size === 1 ? [...siteFilter][0] : null;
      const { data, error } = await supabase.functions.invoke<any>(
        "placements-evaluate",
        { body: { mode: "preview", lookback_days: lookback, from, to, fx_usd_brl: fxUsdBrl, site_id: selectedSiteId ?? undefined } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao avaliar", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      toast({ title: "Funil atualizado", description: `${data?.summary?.total ?? 0} placements analisados (${from} → ${to}), ${data?.summary?.transitions ?? 0} mudanças` });
      await load();
      await loadConfig();
    } finally { setEvaluating(false); }
  };

  const updateStatus = async (id: string, newStatus: Status, reason: string) => {
    setBusyId(id);
    try {
      const row = rows.find((r) => r.id === id);
      const { error } = await supabase.from("placement_status").update({
        status: newStatus,
        manual_override: true,
        reason,
        last_status_change_at: new Date().toISOString(),
        ...(newStatus === "blocked" ? { blocked_at: new Date().toISOString() } : {}),
      }).eq("id", id);
      if (error) throw error;
      if (row) {
        await supabase.from("placement_status_history").insert({
          placement_status_id: id,
          user_id: (await supabase.auth.getUser()).data.user?.id,
          campaign_id: row.campaign_id,
          placement: row.placement,
          from_status: row.status,
          to_status: newStatus,
          reason,
          cost_total: row.cost_total,
          revenue_total: row.revenue_total,
          roi_pct: row.roi_pct,
          triggered_by: "manual",
        });
      }
      toast({ title: "Status atualizado", description: `${row?.placement} → ${STATUS_META[newStatus].label}` });
      await load();
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally { setBusyId(null); }
  };

  const resetPlacement = async (id: string) => {
    setBusyId(id);
    try {
      await supabase.from("placement_status").update({
        status: "test",
        phase: "phase1_test",
        manual_override: false,
        reason: "reset manual",
        prev_roi_pct: null,
        last_status_change_at: new Date().toISOString(),
      }).eq("id", id);
      toast({ title: "Placement resetado" });
      await load();
    } finally { setBusyId(null); }
  };

  // Conjunto efetivo de google_account_ids permitidos pelo filtro (conta + site)
  const allowedAccountIds = useMemo(() => {
    let allowed: Set<string> | null = null;
    if (accountFilter.size > 0) allowed = new Set(accountFilter);
    if (siteFilter.size > 0) {
      const fromSites = new Set<string>();
      for (const s of sites) if (siteFilter.has(s.id)) for (const a of s.account_ids) fromSites.add(a);
      allowed = allowed ? new Set([...allowed].filter((a) => fromSites.has(a))) : fromSites;
    }
    return allowed; // null = sem restrição
  }, [accountFilter, siteFilter, sites]);

  const accountFiltered = useMemo(() => {
    return rows.filter((r) => {
      const accountOk = !allowedAccountIds || (r.google_account_id && allowedAccountIds.has(r.google_account_id));
      if (siteFilter.size > 0) return !!accountOk && !!r.site_id && siteFilter.has(r.site_id);
      return !!accountOk;
    });
  }, [rows, allowedAccountIds, siteFilter]);

  const counts = useMemo(() => {
    const c = { all: accountFiltered.length, test: 0, learning: 0, good: 0, bad: 0, blocked: 0 } as any;
    for (const r of accountFiltered) c[r.status]++;
    return c;
  }, [accountFiltered]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return accountFiltered.filter((r) => (filter === "all" || r.status === filter) &&
      (!s || r.placement.toLowerCase().includes(s) || (r.campaign_name ?? "").toLowerCase().includes(s)));
  }, [accountFiltered, filter, search]);

  const daysSince = (iso: string) => {
    const d = (Date.now() - new Date(iso).getTime()) / 86400_000;
    return d < 1 ? "<1d" : `${Math.round(d)}d`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        <Sparkles className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-[260px]">
          <div className="text-sm font-semibold">Esteira inteligente de placements</div>
          <div className="text-xs text-muted-foreground">
            Funil: <b>test</b> (&lt;R$30) → <b>learning</b> (R$30–100, ROI &gt; -40%) → <b>good/bad</b> (≥R$100) → <b>blocked</b> (≥R$150 e ROI ≤ -30%). Só bloqueia quando claramente ruim.
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Período:</span>
          {[
            { label: "Hoje", v: 1 },
            { label: "Ontem", v: 2 },
            { label: "15d", v: 15 },
            { label: "30d", v: 30 },
          ].map((p) => (
            <button key={p.label} onClick={() => setLookback(p.v)}
              className={cn("text-[11px] rounded-md border px-2 py-1 transition-colors",
                lookback === p.v ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted")}>
              {p.label}
            </button>
          ))}
          <Input type="number" value={lookback} onChange={(e) => setLookback(Math.max(1, +e.target.value || 15))} className="h-7 w-16 text-xs" />
          <span className="text-[10px] text-muted-foreground">dias</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/50">
          <Switch checked={autoEnabled} onCheckedChange={toggleAuto} />
          <div className="text-xs">
            <div className="font-medium flex items-center gap-1">
              Esteira automática a cada
              <Input type="number" value={autoIntervalDays} onChange={(e) => updateAutoInterval(+e.target.value || 15)} className="h-6 w-14 text-xs px-1" />
              dias
            </div>
            <div className="text-muted-foreground text-[10px]">
              checagem diária • {lastRun ? `último: ${new Date(lastRun).toLocaleString("pt-BR")}` : "nunca executado"}
            </div>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={evaluateNow} disabled={evaluating}>
          {evaluating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <RefreshCw className="h-3.5 w-3.5 mr-2" />}
          Rodar agora
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {(["all", "test", "learning", "good", "bad", "blocked"] as const).map((s) => (
          <button key={s} onClick={() => setFilter(s)}
            className={cn("inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              filter === s ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted")}>
            {s === "all" ? "Todos" : STATUS_META[s].label}
            <span className="ml-1 text-[10px] tabular-nums opacity-70">{counts[s]}</span>
          </button>
        ))}

        <MultiPicker label="Contas" items={accounts} selected={accountFilter} onChange={setAccountFilter} />
        <MultiPicker label="Sites" items={sites.map((s) => ({ id: s.id, name: s.name }))} selected={siteFilter} onChange={setSiteFilter} />

        <div className="flex-1 min-w-[220px] flex items-center gap-2 ml-auto">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrar por placement ou campanha..." className="h-8 text-xs" />
        </div>
      </div>

      <FunnelByCampaign
        rows={filtered}
        campaignMetrics={campaignMetrics}
        loading={loading}
        busyId={busyId}
        daysSince={daysSince}
        onBlock={(id, p) => updateStatus(id, "blocked", "force_block manual")}
        onSecondChance={(id) => updateStatus(id, "learning", "second_chance manual")}
        onReset={resetPlacement}
      />

      <CleanupImpactPanel fxUsdBrl={fxUsdBrl} />
    </div>
  );
}

function ConfirmBtn({ icon, label, title, desc, onConfirm, busy, variant }: {
  icon: React.ReactNode; label: string; title: string; desc: string; onConfirm: () => void; busy: boolean;
  variant: "danger" | "default" | "ghost";
}) {
  const cls = variant === "danger" ? "text-danger hover:bg-danger-soft hover:text-danger"
    : variant === "default" ? "text-info hover:bg-info/10 hover:text-info"
    : "text-muted-foreground hover:bg-muted";
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className={cn("h-7 px-2", cls)} disabled={busy} title={label}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{desc}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Confirmar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MultiPicker({ label, items, selected, onChange }: {
  label: string; items: { id: string; name: string }[]; selected: Set<string>; onChange: (s: Set<string>) => void;
}) {
  const allSelected = selected.size === 0;
  const display = allSelected ? `Todas (${items.length})` : `${selected.size} selec.`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1">
          {label}: <span className="font-semibold">{display}</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-auto w-64">
        <DropdownMenuLabel className="text-xs">{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={allSelected} onCheckedChange={() => onChange(new Set())}>
          Todas
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {items.length === 0 && <div className="text-[11px] text-muted-foreground px-2 py-1">— vazio —</div>}
        {items.map((it) => (
          <DropdownMenuCheckboxItem key={it.id} checked={selected.has(it.id)} onSelect={(e) => e.preventDefault()}
            onCheckedChange={(c) => {
              const n = new Set(selected);
              c ? n.add(it.id) : n.delete(it.id);
              onChange(n);
            }}>
            <span className="truncate">{it.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface FBProps {
  rows: Row[];
  campaignMetrics: CampaignMetricSummary[];
  loading: boolean;
  busyId: string | null;
  daysSince: (iso: string) => string;
  onBlock: (id: string, placement: string) => void;
  onSecondChance: (id: string) => void;
  onReset: (id: string) => void;
}

function FunnelByCampaign({ rows, campaignMetrics, loading, busyId, daysSince, onBlock, onSecondChance, onReset }: FBProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const dashboardByCampaign = new Map(campaignMetrics.map((c) => [c.campaign_id, c]));
    const m = new Map<string, { campaign_id: string; name: string; items: Row[] }>();
    for (const r of rows) {
      const cid = r.campaign_id;
      let g = m.get(cid);
      if (!g) { g = { campaign_id: cid, name: r.campaign_name ?? cid, items: [] }; m.set(cid, g); }
      g.items.push(r);
    }
    const list = [...m.values()].map((g) => {
      const dashboard = dashboardByCampaign.get(g.campaign_id);
      const cost = dashboard?.cost ?? g.items.reduce((a, x) => a + (x.cost_total || 0), 0);
      const rev = dashboard?.rev ?? g.items.reduce((a, x) => a + (x.revenue_total || 0), 0);
      const profit = dashboard?.profit ?? (rev - cost);
      const roi = dashboard?.roi ?? (cost > 0 ? (profit / cost) * 100 : 0);
      const blocked = g.items.filter((x) => x.status === "blocked").length;
      const bad = g.items.filter((x) => x.status === "bad").length;
      const good = g.items.filter((x) => x.status === "good").length;
      return { ...g, cost, rev, profit, roi, blocked, bad, good };
    });
    list.sort((a, b) => b.cost - a.cost);
    return list;
  }, [rows, campaignMetrics]);

  const toggle = (cid: string) => setExpanded((s) => { const n = new Set(s); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead className="w-10"></TableHead>
            <TableHead>Campanha</TableHead>
            <TableHead className="text-right">Placements</TableHead>
            <TableHead className="text-right">Custo</TableHead>
            <TableHead className="text-right">Receita</TableHead>
            <TableHead className="text-right">Lucro</TableHead>
            <TableHead className="text-right">ROI</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (<TableRow><TableCell colSpan={8} className="text-center py-8"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando...</TableCell></TableRow>)}
          {!loading && groups.length === 0 && (
            <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
              Nenhum placement ainda. Selecione um site e clique em <b>Sincronizar dados do site</b> no banner — ou em <b>Avaliar agora</b> se já houver dados crus.
            </TableCell></TableRow>
          )}
          {groups.map((g) => {
            const isOpen = expanded.has(g.campaign_id);
            return (
              <Fragment key={g.campaign_id}>
                <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => toggle(g.campaign_id)}>
                  <TableCell><span className="text-xs">{isOpen ? "▼" : "▶"}</span></TableCell>
                  <TableCell className="font-medium text-sm max-w-[320px] truncate" title={g.name}>{g.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{g.items.length}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBRL(g.cost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBRL(g.rev)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", g.profit < 0 && "text-danger")}>{fmtBRL(g.profit)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums font-semibold", g.cost === 0 ? "text-muted-foreground" : g.roi < 0 ? "text-danger" : "text-success")}>{g.cost === 0 ? "—" : fmtPercent(g.roi)}</TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      {g.good > 0 && <Badge className="bg-success-soft text-success border-success/20">{g.good} bom</Badge>}
                      {g.bad > 0 && <Badge className="bg-warning/10 text-warning border-warning/30">{g.bad} ruim</Badge>}
                      {g.blocked > 0 && <Badge className="bg-danger-soft text-danger border-danger/20">{g.blocked} bloq</Badge>}
                    </div>
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow>
                    <TableCell colSpan={8} className="bg-muted/10 p-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Placement</TableHead>
                            <TableHead className="text-right">Status</TableHead>
                            <TableHead className="text-right">Tempo</TableHead>
                            <TableHead className="text-right">Custo</TableHead>
                            <TableHead className="text-right">Receita</TableHead>
                            <TableHead className="text-right">ROI</TableHead>
                            <TableHead className="text-right">Cliques</TableHead>
                            <TableHead className="text-right w-56">Ações</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[...g.items].sort((a, b) => b.cost_total - a.cost_total).map((r) => {
                            const meta = STATUS_META[r.status];
                            return (
                              <TableRow key={r.id}>
                                <TableCell className="text-sm font-medium max-w-[320px] truncate" title={r.placement}>
                                  {r.priority && <Sparkles className="h-3 w-3 inline mr-1 text-primary" />}
                                  {r.placement}
                                  {r.manual_override && <Badge variant="outline" className="ml-2 text-[10px] py-0">manual</Badge>}
                                  {r.reason && <div className="text-[10px] text-muted-foreground truncate" title={r.reason}>{r.reason}</div>}
                                </TableCell>
                                <TableCell className="text-right">
                                  <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold", meta.cls)}>{meta.label}</span>
                                </TableCell>
                                <TableCell className="text-right text-xs text-muted-foreground tabular-nums">{daysSince(r.first_seen_at)}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(r.cost_total)}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtBRL(r.revenue_total)}</TableCell>
                                <TableCell className={cn("text-right tabular-nums font-semibold", r.roi_pct < 0 ? "text-danger" : "text-success")}>{fmtPercent(r.roi_pct)}</TableCell>
                                <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNumber(r.clicks_total)}</TableCell>
                                <TableCell className="text-right">
                                  <div className="inline-flex gap-1">
                                    {r.status !== "blocked" && (
                                      <ConfirmBtn icon={<Ban className="h-3.5 w-3.5" />} label="Forçar bloqueio" variant="danger"
                                        title={`Bloquear ${r.placement}?`} desc="Marca como blocked e adiciona à blacklist na próxima limpeza."
                                        busy={busyId === r.id} onConfirm={() => onBlock(r.id, r.placement)} />
                                    )}
                                    {(r.status === "bad" || r.status === "blocked") && (
                                      <ConfirmBtn icon={<Play className="h-3.5 w-3.5" />} label="2ª chance" variant="default"
                                        title={`Dar segunda chance a ${r.placement}?`} desc="Volta para learning e suspende bloqueio automático."
                                        busy={busyId === r.id} onConfirm={() => onSecondChance(r.id)} />
                                    )}
                                    <ConfirmBtn icon={<RotateCcw className="h-3.5 w-3.5" />} label="Reset" variant="ghost"
                                      title={`Resetar ${r.placement}?`} desc="Volta para test e desliga override manual."
                                      busy={busyId === r.id} onConfirm={() => onReset(r.id)} />
                                  </div>
                                </TableCell>
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
  );
}
