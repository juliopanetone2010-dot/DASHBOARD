import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, RefreshCw, Rocket, Zap, Globe, DownloadCloud } from "lucide-react";

type Cfg = {
  enabled: boolean; dry_run: boolean;
  min_roi_pct: number; max_delivery_rate: number; min_ctr_pct: number;
  min_spend_brl: number; min_conversions: number; lookback_days: number;
  scale_pct: number; reduce_budget_pct: number; relax_cpa_pct: number;
  scale_min_roi_pct: number; scale_min_delivery: number;
  observation_hours: number; cooldown_hours: number; scale_interval_hours: number;
  fail_after_days: number; fail_max_roi: number;
  last_run_at: string | null;
};

const DEFAULT_CFG: Cfg = {
  enabled: false, dry_run: true,
  min_roi_pct: -15, max_delivery_rate: 0.75, min_ctr_pct: 0.5,
  min_spend_brl: 20, min_conversions: 1, lookback_days: 5,
  scale_pct: 20, reduce_budget_pct: 30, relax_cpa_pct: 15,
  scale_min_roi_pct: 20, scale_min_delivery: 0.9,
  observation_hours: 48, cooldown_hours: 24, scale_interval_hours: 48,
  fail_after_days: 4, fail_max_roi: -30,
  last_run_at: null,
};

const STATUS_COLORS: Record<string, string> = {
  idle: "bg-muted text-muted-foreground",
  candidate: "bg-blue-500/15 text-blue-600",
  unlocking: "bg-amber-500/20 text-amber-700",
  observing: "bg-amber-500/15 text-amber-600",
  scaling: "bg-emerald-500/20 text-emerald-700",
  budget_reduced: "bg-purple-500/15 text-purple-600",
  cpa_relaxed: "bg-indigo-500/15 text-indigo-600",
  learning_limited: "bg-orange-500/15 text-orange-600",
  unlock_failed: "bg-destructive/20 text-destructive",
  unlock_succeeded: "bg-emerald-600/20 text-emerald-700",
};
const STATUS_LABEL: Record<string, string> = {
  idle: "Idle", candidate: "Candidata", unlocking: "Destravando",
  observing: "Observando", scaling: "Escalando",
  budget_reduced: "Budget Reduzido", cpa_relaxed: "CPA Relaxado",
  learning_limited: "Learning Limited",
  unlock_failed: "Unlock Failed", unlock_succeeded: "Destravada ✓",
};

export const ScaleUnlockTab = () => {
  const { user } = useAuth();
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_CFG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [states, setStates] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);

  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedSites, setSelectedSites] = useState<Set<string>>(new Set());

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: c }, { data: s }, { data: l }, { data: si }] = await Promise.all([
      supabase.from("scale_unlock_config").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.from("scale_unlock_state").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(200),
      supabase.from("scale_unlock_logs").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50),
      supabase.from("sites").select("id, name").eq("user_id", user.id).order("name"),
    ]);
    if (c) setCfg({ ...DEFAULT_CFG, ...(c as any) });
    setStates(s ?? []);
    setLogs(l ?? []);
    setSites((si ?? []) as any);
    setLoading(false);
  };
  useEffect(() => { void load(); }, [user?.id]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    const { last_run_at: _omit, ...payload } = cfg;
    const { error } = await supabase
      .from("scale_unlock_config")
      .upsert({ user_id: user.id, ...payload }, { onConflict: "user_id" });
    setSaving(false);
    if (error) toast({ title: "Erro ao salvar", description: error.message, variant: "destructive" });
    else toast({ title: "Configurações salvas" });
  };

  const runNow = async (opts?: { forceDry?: boolean; allSites?: boolean }) => {
    const forceDry = opts?.forceDry;
    const allSites = opts?.allSites ?? false;
    setRunning(true);
    const site_ids = allSites
      ? null
      : (selectedSites.size > 0 ? Array.from(selectedSites) : null);
    const { data, error } = await supabase.functions.invoke("scale-unlock-run", {
      body: { dry_run: forceDry ?? cfg.dry_run, ...(site_ids ? { site_ids } : {}) },
    });
    setRunning(false);
    if (error) {
      toast({ title: "Falha ao rodar", description: String(error.message), variant: "destructive" });
      return;
    }
    const r = data as any;
    toast({
      title: forceDry ?? cfg.dry_run ? "Simulação concluída" : "Engine executada",
      description: `${r?.campaigns_evaluated ?? 0} avaliadas · ${r?.actions ?? 0} ações${allSites ? " (todos sites)" : site_ids ? ` (${site_ids.length} sites)` : ""}`,
    });
    void load();
  };

  const toggleSite = (id: string) => {
    setSelectedSites((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const syncCampaigns = async () => {
    setSyncing(true);
    const { data, error } = await supabase.functions.invoke("google-ads-sync-campaigns", {
      body: { date_preset: "LAST_7_DAYS" },
    });
    if (error) {
      setSyncing(false);
      toast({ title: "Falha ao sincronizar", description: String(error.message), variant: "destructive" });
      return;
    }
    toast({
      title: "Campanhas sincronizadas",
      description: `${(data as any)?.campaigns_upserted ?? (data as any)?.upserted ?? "OK"} atualizadas. Rodando engine...`,
    });
    // Re-roda a engine para detectar as novas campanhas
    await runNow({ forceDry: true, allSites: true });
    setSyncing(false);
  };


  const dashCounts = {
    candidates: states.filter((s) => ["candidate", "budget_reduced", "cpa_relaxed", "unlocking"].includes(s.status)).length,
    scaling: states.filter((s) => s.status === "scaling").length,
    succeeded: states.filter((s) => s.status === "unlock_succeeded").length,
    failed: states.filter((s) => s.status === "unlock_failed").length,
    observing: states.filter((s) => s.observe_until && new Date(s.observe_until).getTime() > Date.now()).length,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Rocket className="h-6 w-6 text-primary" />
            Destravar Escala
          </h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Engine isolada que aumenta entrega/spend de campanhas Google Ads travadas mas com sinais bons.
            Não interfere em automação principal, funil, geo, placements ou winners.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={() => load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </Button>
          <Button variant="secondary" onClick={() => runNow({ forceDry: true })} disabled={running || !user}>
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Zap className="h-4 w-4 mr-1.5" />}
            Simular
          </Button>
          <Button onClick={() => runNow({ forceDry: false })} disabled={running || !user || !cfg.enabled}>
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Rocket className="h-4 w-4 mr-1.5" />}
            Rodar selecionados
          </Button>
          <Button
            variant="default"
            onClick={() => runNow({ forceDry: false, allSites: true })}
            disabled={running || !user || !cfg.enabled}
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Globe className="h-4 w-4 mr-1.5" />}
            Rodar TODOS sites (real)
          </Button>
        </div>
      </div>

      {/* Dashboard cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Candidatas", v: dashCounts.candidates, color: "text-blue-600" },
          { label: "Observando", v: dashCounts.observing, color: "text-amber-600" },
          { label: "Escalando", v: dashCounts.scaling, color: "text-emerald-600" },
          { label: "Destravadas", v: dashCounts.succeeded, color: "text-emerald-700" },
          { label: "Falhas", v: dashCounts.failed, color: "text-destructive" },
        ].map((m) => (
          <Card key={m.label}>
            <CardContent className="p-4">
              <div className="text-xs uppercase text-muted-foreground">{m.label}</div>
              <div className={`text-2xl font-bold mt-1 ${m.color}`}>{m.v}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Sites picker */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-4 w-4" /> Sites alvo
            <span className="text-xs font-normal text-muted-foreground">
              ({selectedSites.size === 0 ? "nenhum selecionado · use 'Rodar TODOS sites'" : `${selectedSites.size} selecionado(s)`})
            </span>
          </CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedSites(new Set(sites.map((s) => s.id)))}>
              Selecionar todos
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedSites(new Set())}>
              Limpar
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {sites.length === 0 ? (
            <div className="text-sm text-muted-foreground">Nenhum site cadastrado.</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {sites.map((s) => (
                <label key={s.id} className="flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-accent">
                  <Checkbox checked={selectedSites.has(s.id)} onCheckedChange={() => toggleSite(s.id)} />
                  <span className="text-sm truncate">{s.name}</span>
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Configuração */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Configurações</CardTitle>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch checked={cfg.enabled} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} />
              <Label>Ativada</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={cfg.dry_run} onCheckedChange={(v) => setCfg({ ...cfg, dry_run: v })} />
              <Label>Modo simulação</Label>
            </div>
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Salvando..." : "Salvar"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {([
              ["min_roi_pct", "ROI mínimo (%)"],
              ["max_delivery_rate", "Delivery máx (0–1)"],
              ["min_ctr_pct", "CTR mínimo (%)"],
              ["min_spend_brl", "Spend mínimo (R$)"],
              ["min_conversions", "Conversões mín"],
              ["lookback_days", "Janela (dias)"],
              ["scale_pct", "Escala (% budget)"],
              ["reduce_budget_pct", "Reduzir budget para (%)"],
              ["relax_cpa_pct", "Relaxar CPA (%)"],
              ["scale_min_roi_pct", "ROI p/ escalar (%)"],
              ["scale_min_delivery", "Delivery p/ escalar"],
              ["observation_hours", "Observação (h)"],
              ["cooldown_hours", "Cooldown (h)"],
              ["scale_interval_hours", "Intervalo escala (h)"],
              ["fail_after_days", "Falhar após (dias)"],
              ["fail_max_roi", "ROI p/ falha (%)"],
            ] as Array<[keyof Cfg, string]>).map(([k, label]) => (
              <div key={k as string} className="space-y-1">
                <Label className="text-xs">{label}</Label>
                <Input
                  type="number" step="0.1"
                  value={String(cfg[k] ?? "")}
                  onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) } as Cfg)}
                />
              </div>
            ))}
          </div>
          {cfg.last_run_at && (
            <div className="text-xs text-muted-foreground mt-3">
              Última execução: {new Date(cfg.last_run_at).toLocaleString("pt-BR")}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Estado das campanhas */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
          <CardTitle>Campanhas monitoradas</CardTitle>
          <div className="text-xs text-muted-foreground">
            {selectedSites.size > 0
              ? `Filtrando ${selectedSites.size} site(s) selecionado(s)`
              : `Mostrando todos os sites`}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campanha</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Confiança</TableHead>
                <TableHead className="text-right">ROI</TableHead>
                <TableHead className="text-right">Delivery</TableHead>
                <TableHead className="text-right">CTR</TableHead>
                <TableHead className="text-right">Budget</TableHead>
                <TableHead className="text-right">CPA</TableHead>
                <TableHead>Última ação</TableHead>
                <TableHead>Observa até</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(() => {
                const siteName = new Map(sites.map((s) => [s.id, s.name]));
                const filtered = selectedSites.size === 0
                  ? states
                  : states.filter((s) => s.site_id && selectedSites.has(s.site_id));
                if (filtered.length === 0) {
                  return (
                    <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                      {states.length === 0
                        ? <>Nenhuma campanha avaliada ainda. Clique em <b>Simular</b> ou <b>Rodar agora</b>.</>
                        : "Nenhuma campanha para os sites filtrados."}
                    </TableCell></TableRow>
                  );
                }
                return filtered.map((s) => {
                  const observing = s.observe_until && new Date(s.observe_until).getTime() > Date.now();
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="max-w-[260px]">
                        <div className="font-medium text-sm truncate" title={s.campaign_name ?? s.campaign_id}>
                          {s.campaign_name ?? "—"}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground truncate">{s.campaign_id}</div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {s.site_id ? (siteName.get(s.site_id) ?? s.site_id) : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_COLORS[s.status] ?? STATUS_COLORS.idle}>
                          {STATUS_LABEL[s.status] ?? s.status}
                        </Badge>
                        {observing && <Badge variant="outline" className="ml-1 text-xs">obs</Badge>}
                      </TableCell>
                      <TableCell className="text-right">{Math.round(Number(s.unlock_score) || 0)}</TableCell>
                      <TableCell className="text-right">{Math.round(Number(s.unlock_confidence) || 0)}</TableCell>
                      <TableCell className="text-right">{s.last_roi_pct != null ? `${Number(s.last_roi_pct).toFixed(1)}%` : "—"}</TableCell>
                      <TableCell className="text-right">{s.last_delivery_rate != null ? `${(Number(s.last_delivery_rate) * 100).toFixed(0)}%` : "—"}</TableCell>
                      <TableCell className="text-right">{s.last_ctr_pct != null ? `${Number(s.last_ctr_pct).toFixed(2)}%` : "—"}</TableCell>
                      <TableCell className="text-right">
                        {s.current_budget != null ? `R$ ${Number(s.current_budget).toFixed(0)}` : "—"}
                        {s.base_budget != null && Number(s.base_budget) !== Number(s.current_budget) && (
                          <span className="text-xs text-muted-foreground ml-1">(base R$ {Number(s.base_budget).toFixed(0)})</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{s.current_cpa != null ? `R$ ${Number(s.current_cpa).toFixed(2)}` : "—"}</TableCell>
                      <TableCell className="text-xs">{s.last_action ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {observing ? new Date(s.observe_until).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                });
              })()}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Logs */}
      <Card>
        <CardHeader><CardTitle>Logs recentes</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quando</TableHead>
                <TableHead>Campanha</TableHead>
                <TableHead>Ação</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">ROI antes</TableHead>
                <TableHead className="text-right">Delivery antes</TableHead>
                <TableHead className="text-right">Budget</TableHead>
                <TableHead className="text-right">CPA</TableHead>
                <TableHead>Motivo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-6">Sem logs ainda.</TableCell></TableRow>
              )}
              {logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-xs">{new Date(l.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</TableCell>
                  <TableCell className="text-xs font-mono max-w-[160px] truncate" title={l.campaign_name ?? l.campaign_id}>{l.campaign_name ?? l.campaign_id}</TableCell>
                  <TableCell><Badge variant="outline">{l.action}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={l.status === "executed" ? "default" : l.status === "failed" ? "destructive" : "secondary"}>
                      {l.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs">{l.roi_before != null ? `${Number(l.roi_before).toFixed(1)}%` : "—"}</TableCell>
                  <TableCell className="text-right text-xs">{l.delivery_before != null ? `${(Number(l.delivery_before) * 100).toFixed(0)}%` : "—"}</TableCell>
                  <TableCell className="text-right text-xs">
                    {l.old_budget != null && l.new_budget != null
                      ? `R$ ${Number(l.old_budget).toFixed(0)} → R$ ${Number(l.new_budget).toFixed(0)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {l.old_cpa != null && l.new_cpa != null
                      ? `R$ ${Number(l.old_cpa).toFixed(2)} → R$ ${Number(l.new_cpa).toFixed(2)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-xs max-w-[280px]">{l.reason ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
};
