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
import { cn } from "@/lib/utils";

type Cfg = Record<string, any>;
type Lifecycle = "testing" | "learning" | "standby" | "scaling" | "bad" | "paused";

const STATUS_VARIANT: Record<Lifecycle, { label: string; cls: string }> = {
  testing:  { label: "Testando",  cls: "bg-muted text-muted-foreground" },
  learning: { label: "Aprendendo", cls: "bg-primary/15 text-primary" },
  standby:  { label: "Standby",    cls: "bg-warning/15 text-warning" },
  scaling:  { label: "Escalando",  cls: "bg-success/15 text-success" },
  bad:      { label: "Ruim",       cls: "bg-destructive/15 text-destructive" },
  paused:   { label: "Pausada",    cls: "bg-muted/60 text-muted-foreground line-through" },
};

export function AutomationTab() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [states, setStates] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [campMeta, setCampMeta] = useState<Record<string, { name: string; google_account_id: string | null }>>({});
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [links, setLinks] = useState<{ google_account_id: string; site_id: string }[]>([]);
  const [siteFilter, setSiteFilter] = useState<string>("all");
  const [accountFilter, setAccountFilter] = useState<string[]>([]);
  const [accountPopOpen, setAccountPopOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    const [{ data: c }, { data: s }, { data: l }, { data: camps }, { data: accs }, { data: sts }, { data: lks }] = await Promise.all([
      supabase.from("rules_config").select("*").maybeSingle(),
      supabase.from("campaign_automation").select("*").order("last_evaluated_at", { ascending: false }).limit(500),
      supabase.from("automation_logs").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("campaigns").select("campaign_id, name, status, google_account_id").limit(2000),
      supabase.from("google_accounts").select("id, account_name, descriptive_name, customer_id"),
      supabase.from("sites").select("id, name"),
      supabase.from("account_site_links").select("google_account_id, site_id"),
    ]);
    const meta: Record<string, { name: string; google_account_id: string | null }> = {};
    const activeIds = new Set<string>();
    for (const c of camps ?? []) {
      const cid = String((c as any).campaign_id);
      meta[cid] = { name: String((c as any).name ?? ""), google_account_id: (c as any).google_account_id ?? null };
      const st = String((c as any).status ?? "").toLowerCase();
      if (st === "enabled" || st === "active") activeIds.add(cid);
    }
    setCampMeta(meta);
    setAccounts((accs ?? []).map((a: any) => ({ id: a.id, name: a.account_name || a.descriptive_name || a.customer_id || "(sem nome)" })));
    setSites((sts ?? []).map((s: any) => ({ id: s.id, name: s.name })));
    setLinks((lks ?? []) as any);
    setCfg(c ?? null);
    setStates((s ?? []).filter((row: any) => activeIds.has(String(row.campaign_id))));
    setLogs(l ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

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

  const filteredStates = useMemo(() => states.filter((s) => matchCampaign(String(s.campaign_id))), [states, campMeta, accountFilter, allowedAccountIds]);
  const filteredLogs = useMemo(() => logs.filter((l) => matchCampaign(String(l.campaign_id))), [logs, campMeta, accountFilter, allowedAccountIds]);

  type SortKey = "name" | "lifecycle_status" | "last_roi" | "roi_trend" | "days_in_standby" | "last_action_date" | "cooldown_until";
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "last_roi", dir: "desc" });
  const toggleSort = (key: SortKey) => setSort((p) => p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  const sortedStates = useMemo(() => {
    const arr = [...filteredStates];
    const dir = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: any, bv: any;
      if (sort.key === "name") { av = (campMeta[a.campaign_id]?.name ?? "").toLowerCase(); bv = (campMeta[b.campaign_id]?.name ?? "").toLowerCase(); }
      else if (sort.key === "last_roi" || sort.key === "days_in_standby") { av = Number(a[sort.key] ?? -Infinity); bv = Number(b[sort.key] ?? -Infinity); }
      else if (sort.key === "last_action_date" || sort.key === "cooldown_until") { av = a[sort.key] ? new Date(a[sort.key]).getTime() : 0; bv = b[sort.key] ? new Date(b[sort.key]).getTime() : 0; }
      else { av = String(a[sort.key] ?? ""); bv = String(b[sort.key] ?? ""); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [filteredStates, sort, campMeta]);
  const SortIcon = ({ k }: { k: SortKey }) => sort.key !== k ? <ArrowUpDown className="inline h-3 w-3 ml-1 opacity-40" /> : sort.dir === "asc" ? <ArrowUp className="inline h-3 w-3 ml-1" /> : <ArrowDown className="inline h-3 w-3 ml-1" />;

  const set = (k: string, v: any) => setCfg((p) => ({ ...(p ?? {}), [k]: v }));

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    const { error } = await supabase.from("rules_config").update(cfg as any).eq("user_id", cfg.user_id);
    setSaving(false);
    if (error) toast({ title: "Erro ao salvar", description: error.message, variant: "destructive" });
    else toast({ title: "Configurações salvas" });
  };

  const run = async (force = false) => {
    setRunning(true);
    const { data, error } = await supabase.functions.invoke("automation-run", { body: { force } });
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
              {cfg.automation_enabled ? <Badge className="bg-success/15 text-success">Ativa</Badge> : <Badge variant="outline">Inativa</Badge>}
            </h2>
            <p className="text-sm text-muted-foreground">
              Esteira inteligente: testing → learning → standby → scaling/bad → paused.
              {cfg.automation_last_run_at && <> Última execução: <b>{new Date(cfg.automation_last_run_at).toLocaleString("pt-BR")}</b></>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} className="gap-2"><RefreshCw className="h-4 w-4" />Atualizar</Button>
          <Button size="sm" onClick={() => run(true)} disabled={running} className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Rodar agora
          </Button>
        </div>
      </div>

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
        <div className="ml-auto text-xs text-muted-foreground">{filteredStates.length} campanha(s)</div>
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
                  <TableHead className="text-right cursor-pointer select-none" onClick={() => toggleSort("last_roi")}>ROI<SortIcon k="last_roi" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("roi_trend")}>Tendência<SortIcon k="roi_trend" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("days_in_standby")}>Standby<SortIcon k="days_in_standby" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("last_action_date")}>Última ação<SortIcon k="last_action_date" /></TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort("cooldown_until")}>Cooldown até<SortIcon k="cooldown_until" /></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedStates.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Nenhuma campanha avaliada ainda. Clique em "Rodar agora".</TableCell></TableRow>}
                {sortedStates.map((s) => {
                  const v = STATUS_VARIANT[s.lifecycle_status as Lifecycle] ?? STATUS_VARIANT.testing;
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs">
                        <div className="font-medium">{campMeta[s.campaign_id]?.name || "(sem nome)"}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{s.campaign_id}</div>
                      </TableCell>
                      <TableCell><span className={`px-2 py-0.5 rounded text-xs ${v.cls}`}>{v.label}</span></TableCell>
                      <TableCell className="text-right font-mono">{s.last_roi != null ? `${Number(s.last_roi).toFixed(1)}%` : "—"}</TableCell>
                      <TableCell className="text-xs">{s.roi_trend ?? "—"}</TableCell>
                      <TableCell className="text-xs">{s.days_in_standby > 0 ? `${s.days_in_standby}d` : "—"}</TableCell>
                      <TableCell className="text-xs">{s.last_action ? `${s.last_action} · ${s.last_action_date ? new Date(s.last_action_date).toLocaleDateString("pt-BR") : ""}` : "—"}</TableCell>
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
              <Toggle label="Automação ativa" hint="Habilita execução pelo cron diário (04:00 BRT)." checked={!!cfg.automation_enabled} onChange={(v) => set("automation_enabled", v)} />
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
  return (
    <div className="space-y-1.5">
      <Label htmlFor={k}>{label}</Label>
      <Input id={k} type="number" step={step} value={cfg[k] ?? 0} onChange={(e) => set(k, parseFloat(e.target.value) || 0)} />
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
