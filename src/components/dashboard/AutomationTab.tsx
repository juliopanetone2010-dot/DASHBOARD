import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Save, RefreshCw, Bot, Check, ChevronsUpDown, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useDashboardFilters } from "@/contexts/FilterContext";
import { cn } from "@/lib/utils";
import { SitesAutomationPanel } from "./SitesAutomationPanel";
import { AutomationRollbackPanel } from "./AutomationRollbackPanel";
import { NET_FACTOR } from "@/engine/rules";

type Cfg = Record<string, any>;
type Lifecycle =
  | "testing" | "learning" | "standby" | "scaling" | "bad" | "paused"
  | "winner_test" | "winner_scaling" | "winner_standby" | "winner_paused";

const STATUS_VARIANT: Record<Lifecycle, { label: string; cls: string }> = {
  testing:  { label: "Testando",  cls: "bg-muted text-muted-foreground" },
  learning: { label: "Aprendendo", cls: "bg-primary/15 text-primary" },
  standby:  { label: "Standby",    cls: "bg-warning/15 text-warning" },
  scaling:  { label: "Escalando",  cls: "bg-success/15 text-success" },
  bad:      { label: "Ruim",       cls: "bg-destructive/15 text-destructive" },
  paused:   { label: "Pausada",    cls: "bg-muted/60 text-muted-foreground line-through" },
  winner_test:    { label: "Winner • Teste 7d",    cls: "bg-accent/20 text-accent-foreground" },
  winner_scaling: { label: "Winner • Escalando",   cls: "bg-success/20 text-success" },
  winner_standby: { label: "Winner • Standby",     cls: "bg-warning/20 text-warning" },
  winner_paused:  { label: "Winner • Pausada",     cls: "bg-muted/60 text-muted-foreground" },
};

export function AutomationTab() {
  const { filters: globalFilters } = useDashboardFilters();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [states, setStates] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [campMeta, setCampMeta] = useState<Record<string, { name: string; google_account_id: string | null; created_at: string | null }>>({});
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [links, setLinks] = useState<{ google_account_id: string; site_id: string }[]>([]);
  const [siteAutomation, setSiteAutomation] = useState<any[]>([]);
  const [todayRoiByCampaign, setTodayRoiByCampaign] = useState<Record<string, number | null>>({});
  const [spendByCampaign, setSpendByCampaign] = useState<Record<string, number>>({});
  const [siteFilter, setSiteFilter] = useState<string>(globalFilters.siteId || "all");
  const [accountFilter, setAccountFilter] = useState<string[]>([]);
  const [accountPopOpen, setAccountPopOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [showNew, setShowNew] = useState(true);

  const load = async () => {
    setLoading(true);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400_000);
    const start15 = new Date(today.getTime() - 15 * 86400_000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    let statesQuery = supabase.from("campaign_automation").select("*").order("last_evaluated_at", { ascending: false }).limit(2000);
    let logsQuery = supabase.from("automation_logs").select("*").order("created_at", { ascending: false }).limit(2000);
    if (siteFilter !== "all") {
      statesQuery = statesQuery.or(`site_id.eq.${siteFilter},site_id.is.null`);
      logsQuery = logsQuery.or(`site_id.eq.${siteFilter},site_id.is.null`);
    }
    const [{ data: c }, { data: s }, { data: l }, { data: camps }, { data: accs }, { data: sts }, { data: lks }, { data: sac }, { data: rangeMetrics }] = await Promise.all([
      supabase.from("rules_config").select("*").maybeSingle(),
      statesQuery,
      logsQuery,
      supabase.from("campaigns").select("campaign_id, name, status, google_account_id, created_at").limit(2000),
      supabase.from("google_accounts").select("id, account_name, descriptive_name, customer_id"),
      supabase.from("sites").select("id, name"),
      supabase.from("account_site_links").select("google_account_id, site_id"),
      supabase.from("site_automation_config").select("*"),
      supabase.from("daily_metrics").select("campaign_id, google_account_id, spend, profit, date").gte("date", ymd(start15)).limit(20000),
    ]);
    const meta: Record<string, { name: string; google_account_id: string | null; created_at: string | null }> = {};
    const activeIds = new Set<string>();
    for (const c of camps ?? []) {
      const cid = String((c as any).campaign_id);
      meta[cid] = { name: String((c as any).name ?? ""), google_account_id: (c as any).google_account_id ?? null, created_at: (c as any).created_at ?? null };
      const st = String((c as any).status ?? "").toLowerCase();
      if (st === "enabled" || st === "active") activeIds.add(cid);
    }
    // Determina quais (account_id) têm automação ativa em algum site → usa "ROI ontem"
    const automationActiveAccounts = new Set<string>(
      ((sac ?? []) as any[]).filter((r) => r.automation_enabled).map((r) => String(r.google_account_id)),
    );
    // Agrega métricas: por campanha, soma 15d e isola o dia de ontem
    const aggBy: Record<string, { spend15: number; profit15: number; spendY: number; profitY: number }> = {};
    const yIso = ymd(yesterday);
    for (const m of rangeMetrics ?? []) {
      const cid = String((m as any).campaign_id);
      const sp = Number((m as any).spend ?? 0);
      const pr = Number((m as any).profit ?? 0);
      const acc = aggBy[cid] ?? (aggBy[cid] = { spend15: 0, profit15: 0, spendY: 0, profitY: 0 });
      acc.spend15 += sp; acc.profit15 += pr;
      if ((m as any).date === yIso) { acc.spendY += sp; acc.profitY += pr; }
    }
    const todayMap: Record<string, number | null> = {};
    for (const cid of Object.keys(aggBy)) {
      const a = aggBy[cid];
      // Sempre usa ROI de ontem (dia completo). Hoje fica desatualizado durante o dia.
      const spend = a.spendY;
      const profit = a.profitY;
      const grossRev = spend + profit;
      todayMap[cid] = spend > 0 ? (((grossRev * NET_FACTOR) - spend) / spend) * 100 : null;
    }
    setCampMeta(meta);
    setAccounts((accs ?? []).map((a: any) => ({ id: a.id, name: a.account_name || a.descriptive_name || a.customer_id || "(sem nome)" })));
    setSites((sts ?? []).map((s: any) => ({ id: s.id, name: s.name })));
    setLinks((lks ?? []) as any);
    setSiteAutomation((sac ?? []) as any[]);
    setTodayRoiByCampaign(todayMap);
    const spendMap: Record<string, number> = {};
    for (const cid of Object.keys(aggBy)) spendMap[cid] = aggBy[cid].spend15;
    setSpendByCampaign(spendMap);
    setCfg(c ?? null);
    setStates((s ?? []).filter((row: any) => activeIds.has(String(row.campaign_id))));
    setLogs(l ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, [siteFilter]);
  // Sincroniza com o seletor global de site (header)
  useEffect(() => {
    setSiteFilter(globalFilters.siteId || "all");
    setAccountFilter([]);
  }, [globalFilters.siteId]);

  const allowedAccountIds = useMemo(() => {
    if (siteFilter === "all") return null;
    return new Set(links.filter((l) => l.site_id === siteFilter).map((l) => l.google_account_id));
  }, [siteFilter, links]);

  const matchCampaign = (cid: string) => {
    const m = campMeta[cid];
    const accId = m?.google_account_id ?? null;
    if (accountFilter.length > 0 && (!accId || !accountFilter.includes(accId))) return false;
    if (allowedAccountIds && (!accId || !allowedAccountIds.has(accId))) return false;
    return true;
  };

  const matchAutomationRow = (row: any) => {
    if (siteFilter !== "all" && row.site_id && row.site_id !== siteFilter) return false;
    return matchCampaign(String(row.campaign_id));
  };

  const filteredStates = useMemo(() => {
    // Oculta pausadas/ruins que nunca gastaram (>= R$1) — evita poluir a tela com campanhas sem volume
    const meaningful = states.filter((s) => {
      const lc = String(s.lifecycle_status ?? "");
      const isPausedLike = lc.includes("paused") || lc === "bad";
      if (!isPausedLike) return true;
      const sp = spendByCampaign[String(s.campaign_id)] ?? 0;
      return sp > 1;
    });
    const base = meaningful.filter(matchAutomationRow);
    if (!showNew) return base;
    const have = new Set(base.map((s) => String(s.campaign_id)));
    const threeDaysMs = 3 * 86400_000;
    const now = Date.now();
    const synthetic: any[] = [];
    for (const [cid, m] of Object.entries(campMeta)) {
      if (have.has(cid)) continue;
      if (!m.created_at) continue;
      if (now - new Date(m.created_at).getTime() > threeDaysMs) continue;
      if (!matchCampaign(cid)) continue;
      synthetic.push({
        id: `new-${cid}`,
        campaign_id: cid,
        google_account_id: m.google_account_id,
        site_id: null,
        lifecycle_status: "testing",
        last_roi: null,
        roi_trend: null,
        days_in_standby: 0,
        last_action: null,
        last_action_date: null,
        cooldown_until: null,
        delivery_ratio: null,
        daily_budget: null,
        _isNew: true,
        created_at: m.created_at,
      });
    }
    return [...synthetic, ...base];
  }, [states, campMeta, accountFilter, allowedAccountIds, siteFilter, showNew, spendByCampaign]);
  const filteredLogs = useMemo(() => logs.filter(matchAutomationRow), [logs, campMeta, accountFilter, allowedAccountIds, siteFilter]);

  type SortKey = "name" | "lifecycle_status" | "last_roi" | "roi_trend" | "days_in_standby" | "last_action_date" | "cooldown_until";
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "last_roi", dir: "desc" });
  const toggleSort = (key: SortKey) => setSort((p) => p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  const sortedStates = useMemo(() => {
    const arr = [...filteredStates];
    const dir = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: any, bv: any;
      if (sort.key === "name") { av = (campMeta[a.campaign_id]?.name ?? "").toLowerCase(); bv = (campMeta[b.campaign_id]?.name ?? "").toLowerCase(); }
      else if (sort.key === "last_roi") { av = Number(todayRoiByCampaign[String(a.campaign_id)] ?? a.last_roi ?? -Infinity); bv = Number(todayRoiByCampaign[String(b.campaign_id)] ?? b.last_roi ?? -Infinity); }
      else if (sort.key === "days_in_standby") { av = Number(a[sort.key] ?? -Infinity); bv = Number(b[sort.key] ?? -Infinity); }
      else if (sort.key === "last_action_date" || sort.key === "cooldown_until") { av = a[sort.key] ? new Date(a[sort.key]).getTime() : 0; bv = b[sort.key] ? new Date(b[sort.key]).getTime() : 0; }
      else { av = String(a[sort.key] ?? ""); bv = String(b[sort.key] ?? ""); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [filteredStates, sort, campMeta, todayRoiByCampaign]);
  const SortIcon = ({ k }: { k: SortKey }) => sort.key !== k ? <ArrowUpDown className="inline h-3 w-3 ml-1 opacity-40" /> : sort.dir === "asc" ? <ArrowUp className="inline h-3 w-3 ml-1" /> : <ArrowDown className="inline h-3 w-3 ml-1" />;

  const set = (k: string, v: any) => setCfg((p) => ({ ...(p ?? {}), [k]: v }));

  const selectedLinkedAccounts = useMemo(() => {
    if (siteFilter === "all") return [];
    const linked = links.filter((l) => l.site_id === siteFilter).map((l) => l.google_account_id);
    return accountFilter.length > 0 ? linked.filter((id) => accountFilter.includes(id)) : linked;
  }, [siteFilter, links, accountFilter]);

  const activeSiteAccountKeys = useMemo(() => new Set(
    siteAutomation.filter((row) => row.automation_enabled).map((row) => `${row.site_id}|${row.google_account_id}`),
  ), [siteAutomation]);

  const siteAutomationActive = siteFilter !== "all" && selectedLinkedAccounts.length > 0
    && selectedLinkedAccounts.every((accountId) => activeSiteAccountKeys.has(`${siteFilter}|${accountId}`));

  const upsertSiteAutomation = async (enabled: boolean) => {
    if (!cfg || siteFilter === "all" || selectedLinkedAccounts.length === 0) {
      toast({ title: "Selecione um site", description: "A automação só pode ser ativada para um site específico.", variant: "destructive" });
      return;
    }
    setSaving(true);
    const rows = selectedLinkedAccounts.map((accountId) => ({
      user_id: cfg.user_id,
      site_id: siteFilter,
      google_account_id: accountId,
      automation_enabled: enabled,
      automation_dry_run: !!cfg.automation_dry_run,
    }));
    const { error } = await supabase.from("site_automation_config").upsert(rows, { onConflict: "user_id,site_id,google_account_id" });
    setSaving(false);
    if (error) toast({ title: "Erro ao salvar automação do site", description: error.message, variant: "destructive" });
    else { toast({ title: enabled ? "Automação ativada para este site" : "Automação desativada para este site" }); await load(); }
  };

  const save = async () => {
    if (!cfg) return;
    const safeCfg = { ...cfg };
    if (!Number.isFinite(Number(safeCfg.auto_stoploss_min_roi)) || Number(safeCfg.auto_stoploss_min_roi) >= 0) {
      safeCfg.auto_stoploss_min_roi = -20;
    }
    setSaving(true);
    const { error } = await supabase.from("rules_config").update(safeCfg as any).eq("user_id", safeCfg.user_id);
    setSaving(false);
    if (error) toast({ title: "Erro ao salvar", description: error.message, variant: "destructive" });
    else { setCfg(safeCfg); toast({ title: "Configurações salvas" }); }
  };

  const run = async (force = false) => {
    if (siteFilter === "all" || selectedLinkedAccounts.length === 0) {
      toast({ title: "Selecione um site", description: "Rodar agora exige um site específico para evitar afetar outras campanhas.", variant: "destructive" });
      return;
    }
    setRunning(true);
    const { data, error } = await supabase.functions.invoke("automation-run", { body: { force, site_id: siteFilter, google_account_ids: selectedLinkedAccounts } });
    setRunning(false);
    if (error) toast({ title: "Erro", description: error.message, variant: "destructive" });
    else { toast({ title: "Automação executada", description: JSON.stringify((data as any)?.runs?.[0] ?? {}) }); await load(); }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { testing: 0, learning: 0, standby: 0, scaling: 0, bad: 0, paused: 0 };
    for (const s of filteredStates) c[s.lifecycle_status] = (c[s.lifecycle_status] ?? 0) + 1;
    return c;
  }, [filteredStates]);

  if (loading || !cfg) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando…</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-border bg-card p-5 shadow-elegant flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center"><Bot className="h-5 w-5 text-primary" /></div>
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              Automação de campanhas
              {cfg.automation_dry_run && <Badge variant="secondary">Dry-run</Badge>}
              {siteAutomationActive ? <Badge className="bg-success/15 text-success">Ativa no site</Badge> : <Badge variant="outline">Inativa no site</Badge>}
            </h2>
            <p className="text-sm text-muted-foreground">
              Esteira inteligente: testing → learning → standby → scaling/bad → paused.
              {cfg.automation_last_run_at && <> Última execução: <b>{new Date(cfg.automation_last_run_at).toLocaleString("pt-BR")}</b></>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} className="gap-2"><RefreshCw className="h-4 w-4" />Atualizar</Button>
          <Button size="sm" onClick={() => run(true)} disabled={running || siteFilter === "all" || selectedLinkedAccounts.length === 0} className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Rodar agora
          </Button>
        </div>
      </div>

      {/* Pausas em revisão / rollback. Mostrado antes dos filtros porque é o
          local onde o operador costuma agir quando entra com a desconfiança
          "a automação pausou alguma campanha boa?". */}
      <AutomationRollbackPanel siteId={siteFilter} />

      {/* Filtros */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5 min-w-[200px]">
          <Label className="text-xs">Site</Label>
          <Select value={siteFilter} onValueChange={setSiteFilter}>
            <SelectTrigger><SelectValue placeholder="Todos os sites" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os sites</SelectItem>
              {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 min-w-[260px]">
          <Label className="text-xs">Contas Google Ads</Label>
          <Popover open={accountPopOpen} onOpenChange={setAccountPopOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                <span className="truncate">
                  {accountFilter.length === 0 ? "Todas as contas" : accountFilter.length === 1
                    ? accounts.find((a) => a.id === accountFilter[0])?.name ?? "1 conta"
                    : `${accountFilter.length} contas`}
                </span>
                <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[320px] p-0" align="start">
              <div className="max-h-[280px] overflow-y-auto py-1">
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                  onClick={() => setAccountFilter([])}
                >
                  <Check className={cn("h-4 w-4", accountFilter.length === 0 ? "opacity-100" : "opacity-0")} />
                  Todas as contas
                </button>
                {accounts.map((a) => {
                  const checked = accountFilter.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                      onClick={() => setAccountFilter((prev) => checked ? prev.filter((x) => x !== a.id) : [...prev, a.id])}
                    >
                      <Check className={cn("h-4 w-4", checked ? "opacity-100" : "opacity-0")} />
                      <span className="truncate">{a.name}</span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {(siteFilter !== "all" || accountFilter.length > 0) && (
          <Button variant="ghost" size="sm" onClick={() => { setSiteFilter("all"); setAccountFilter([]); }}>Limpar filtros</Button>
        )}
        <div className="flex items-center gap-2 ml-2">
          <Switch id="show-new" checked={showNew} onCheckedChange={setShowNew} />
          <Label htmlFor="show-new" className="text-xs cursor-pointer">Incluir novas (3d)</Label>
        </div>
        <div className="ml-auto text-xs text-muted-foreground">{filteredStates.length} campanha(s)</div>
      </div>

      <SitesAutomationPanel userId={cfg?.user_id ?? null} />

      <div className="rounded-xl border border-border bg-card p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h3 className="font-semibold">Automação do site selecionado no filtro</h3>
          <p className="text-sm text-muted-foreground">
            {siteFilter === "all" ? "Selecione um site no filtro acima para rodar a automação manualmente." : `${selectedLinkedAccounts.length} conta(s) vinculada(s) ao site selecionado.`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Ativar (filtro atual)</span>
          <Switch checked={siteAutomationActive} disabled={saving || siteFilter === "all" || selectedLinkedAccounts.length === 0} onCheckedChange={upsertSiteAutomation} />
        </div>
      </div>

      {/* Esteira (counts) */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {(Object.keys(STATUS_VARIANT) as Lifecycle[]).map((k) => (
          <div key={k} className="rounded-lg border border-border bg-card p-3">
            <div className="text-xs text-muted-foreground">{STATUS_VARIANT[k].label}</div>
            <div className="text-2xl font-bold">{counts[k] ?? 0}</div>
          </div>
        ))}
      </div>

      <Tabs defaultValue="status">
        <TabsList>
          <TabsTrigger value="status">Esteira</TabsTrigger>
          <TabsTrigger value="logs">Debug / Logs</TabsTrigger>
          <TabsTrigger value="config">Configurações</TabsTrigger>
        </TabsList>

        <TabsContent value="status" className="mt-4">
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("name")}>Campanha<SortIcon k="name" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("lifecycle_status")}>Status<SortIcon k="lifecycle_status" /></TableHead>
                  <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("last_roi")} title="ROI de ontem (dia completo). Hoje ainda está em curso e fica desatualizado.">ROI ontem<SortIcon k="last_roi" /></TableHead>
                  <TableHead className="text-right">Delivery</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("roi_trend")}>Tendência<SortIcon k="roi_trend" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("days_in_standby")}>Standby<SortIcon k="days_in_standby" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("last_action_date")}>Última ação<SortIcon k="last_action_date" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("cooldown_until")}>Cooldown até<SortIcon k="cooldown_until" /></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedStates.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Nenhuma campanha avaliada ainda. Clique em "Rodar agora".</TableCell></TableRow>}
                {sortedStates.map((s) => {
                  const v = STATUS_VARIANT[s.lifecycle_status as Lifecycle] ?? STATUS_VARIANT.testing;
                  const todayRoi = todayRoiByCampaign[String(s.campaign_id)];
                  const displayRoi = todayRoi ?? s.last_roi;
                  const dPct = s.delivery_ratio != null ? Math.round(Number(s.delivery_ratio) * 100) : null;
                  const dCls = dPct == null ? "text-muted-foreground" : dPct >= 80 ? "text-emerald-500" : dPct >= 50 ? "text-amber-500" : "text-rose-500";
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs">
                        <div className="font-medium flex items-center gap-1.5">
                          {campMeta[s.campaign_id]?.name || "(sem nome)"}
                          {s._isNew && <Badge className="bg-primary/15 text-primary text-[10px] px-1.5 py-0">✨ Nova</Badge>}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground">{s.campaign_id}</div>
                      </TableCell>
                      <TableCell><span className={`px-2 py-0.5 rounded text-xs ${v.cls}`}>{v.label}</span></TableCell>
                      <TableCell className="text-right font-mono" title={`ROI exibido: ${displayRoi != null ? Number(displayRoi).toFixed(1) + "%" : "—"} · (ontem se automação ativa, senão média 15d) · ROI janela ${cfg?.auto_analysis_days ?? 15}d salvo: ${s.last_roi != null ? Number(s.last_roi).toFixed(1) + "%" : "—"}`}>{displayRoi != null ? `${Number(displayRoi).toFixed(1)}%` : "—"}</TableCell>
                      <TableCell className={`text-right font-mono text-xs ${dCls}`} title={s.daily_budget ? `Orçamento diário: ${Number(s.daily_budget).toFixed(2)}` : ""}>{dPct != null ? `${dPct}%` : "—"}</TableCell>
                      <TableCell className="text-xs">{s.roi_trend ?? "—"}</TableCell>
                      <TableCell className="text-xs">{s.days_in_standby > 0 ? `${s.days_in_standby}d` : "—"}</TableCell>
                      <TableCell className="text-xs">{(() => {
                        const act = s.last_action;
                        const isPaused = String(s.lifecycle_status).includes("paused");
                        // Esconde "pause" quando a campanha não está realmente pausada (registro antigo/dry-run)
                        if (!act || (act === "pause" && !isPaused)) return "—";
                        return `${act} · ${s.last_action_date ? new Date(s.last_action_date).toLocaleDateString("pt-BR") : ""}`;
                      })()}</TableCell>
                      <TableCell className="text-xs">{s.cooldown_until && new Date(s.cooldown_until) > new Date() ? new Date(s.cooldown_until).toLocaleDateString("pt-BR") : "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Campanha</TableHead>
                  <TableHead>Ação</TableHead>
                  <TableHead>Decisão</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead>De → Para</TableHead>
                  <TableHead>Motivo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Sem logs ainda.</TableCell></TableRow>}
                {filteredLogs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs whitespace-nowrap">{new Date(l.created_at).toLocaleString("pt-BR")}</TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium">{campMeta[l.campaign_id]?.name || "(sem nome)"}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{l.campaign_id}</div>
                    </TableCell>
                    <TableCell className="text-xs"><Badge variant="outline">{l.action}</Badge></TableCell>
                    <TableCell className="text-xs">
                      <Badge variant={l.decision === "executed" ? "default" : l.decision === "failed" ? "destructive" : "secondary"}>{l.decision}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{l.roi != null ? `${Number(l.roi).toFixed(1)}%` : "—"}</TableCell>
                    <TableCell className="text-xs">{l.lifecycle_from ?? "—"} → {l.lifecycle_to ?? "—"}</TableCell>
                    <TableCell className="text-xs max-w-md truncate" title={l.reason ?? ""}>{l.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="config" className="mt-4 space-y-6">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 className="font-semibold">Geral</h3>
            <div className="grid md:grid-cols-2 gap-4">
              <Toggle label="Modo dry-run" hint="Apenas registra decisões em logs, NÃO executa no Google Ads." checked={!!cfg.automation_dry_run} onChange={(v) => set("automation_dry_run", v)} />
              <Num label="Dias de análise" k="auto_analysis_days" cfg={cfg} set={set} step="1" />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 className="font-semibold">Stop loss</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <Num label="Dias negativos para pausar" k="auto_stoploss_days" cfg={cfg} set={set} step="1" />
              <Num label="ROI mínimo (%)" k="auto_stoploss_min_roi" cfg={cfg} set={set} />
              <Num label="Custo mínimo (R$)" k="auto_stoploss_min_cost" cfg={cfg} set={set} />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 className="font-semibold">Escala</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <Num label="ROI mínimo para escalar (%)" k="auto_scale_min_roi" cfg={cfg} set={set} />
              <Num label="Aumento de orçamento (%)" k="auto_scale_budget_pct" cfg={cfg} set={set} />
              <Num label="Intervalo de escala (dias)" k="auto_scale_interval_days" cfg={cfg} set={set} step="1" />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 className="font-semibold">CPA</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <Num label="Aumento CPA (%)" k="auto_cpa_up_pct" cfg={cfg} set={set} />
              <Num label="Redução CPA (%)" k="auto_cpa_down_pct" cfg={cfg} set={set} />
              <Num label="Reavaliar após (dias)" k="auto_cpa_review_days" cfg={cfg} set={set} step="1" />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 className="font-semibold">Standby</h3>
            <div className="grid md:grid-cols-2 gap-4">
              <Num label="ROI neutro mínimo (%)" k="auto_standby_roi_low" cfg={cfg} set={set} />
              <Num label="ROI neutro máximo (%)" k="auto_standby_roi_high" cfg={cfg} set={set} />
              <Num label="Dias para entrar em standby" k="auto_standby_enter_days" cfg={cfg} set={set} step="1" />
              <Num label="Dias máx. em standby antes de pausar" k="auto_standby_max_days" cfg={cfg} set={set} step="1" />
              <Num label="ROI para sair do standby (%)" k="auto_standby_exit_roi" cfg={cfg} set={set} />
            </div>
          </div>

          <Separator />
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Num({ label, k, cfg, set, step = "0.01" }: { label: string; k: string; cfg: any; set: (k: string, v: any) => void; step?: string }) {
  const isStopLossRoi = k === "auto_stoploss_min_roi";
  return (
    <div className="space-y-1.5">
      <Label htmlFor={k}>{label}</Label>
      <Input
        id={k}
        type="number"
        step={step}
        max={isStopLossRoi ? -0.01 : undefined}
        value={cfg[k] ?? 0}
        onChange={(e) => {
          const parsed = parseFloat(e.target.value) || 0;
          set(k, isStopLossRoi && parsed >= 0 ? -20 : parsed);
        }}
      />
      {isStopLossRoi && <p className="text-xs text-muted-foreground">Tem que ser negativo. Ex.: -20 pausa só abaixo de -20%.</p>}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div>
        <p className="font-medium text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
