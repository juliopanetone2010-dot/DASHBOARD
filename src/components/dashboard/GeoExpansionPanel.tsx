import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Rocket, Sparkles, Play, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent } from "@/lib/format";

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
}

export function GeoExpansionPanel({ siteId }: { siteId: string | null }) {
  const [loading, setLoading] = useState(false);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [bulkCreating, setBulkCreating] = useState(false);
  const [items, setItems] = useState<Winner[]>([]);
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
  const [budgetMult, setBudgetMult] = useState(0.5);
  const [lastRun, setLastRun] = useState<string | null>(null);

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
        setBudgetMult(Number(data.geo_expansion_budget_multiplier ?? 0.5));
        setLastRun(data.geo_expansion_last_run_at ?? null);
      }
    })();
  }, []);

  const loadCreated = useCallback(async () => {
    setLoadingCreated(true);
    try {
      let q = (supabase.from("campaign_expansion_logs") as any)
        .select("id, original_campaign_id, original_campaign_name, new_campaign_id, new_campaign_name, country_code, country_name, roi_pct, cost_brl, revenue_brl, budget_micros, status, executed_at")
        .eq("action", "created")
        .order("executed_at", { ascending: false })
        .limit(100);
      if (siteId) q = q.eq("site_id", siteId);
      const { data } = await q;
      setCreated((data ?? []) as CreatedLog[]);
    } finally { setLoadingCreated(false); }
  }, [siteId]);

  useEffect(() => { loadCreated(); }, [loadCreated]);

  const persist = async (patch: Record<string, unknown>) => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await (supabase.from("rules_config") as any).update(patch).eq("user_id", u.user.id);
  };

  const loadPreview = async () => {
    if (!siteId) {
      toast({ title: "Selecione um site", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("geo-expansion", {
        body: {
          mode: "preview",
          site_id: siteId,
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
    } finally { setLoading(false); }
  };

  const createOne = async (it: Winner) => {
    const k = `${it.campaign_id}|${it.country_code}`;
    setCreatingKey(k);
    try {
      const { data, error } = await supabase.functions.invoke("geo-expansion", {
        body: {
          mode: "apply",
          site_id: siteId,
          budget_multiplier: budgetMult,
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
      toast({
        title: "Campanha criada (PAUSED)",
        description: `${(data as any)?.new_campaign_name} • ${(data as any)?.ad_groups_cloned} ad groups • ${(data as any)?.ads_cloned} ads`,
      });
      setItems((s) => s.filter((x) => `${x.campaign_id}|${x.country_code}` !== k));
      await loadCreated();
      setTab("created");
    } finally { setCreatingKey(null); }
  };

  const createAll = async () => {
    if (items.length === 0) return;
    setBulkCreating(true);
    let ok = 0; let fail = 0;
    try {
      for (const it of items) {
        try {
          const { data } = await supabase.functions.invoke("geo-expansion", {
            body: { mode: "apply", site_id: siteId, budget_multiplier: budgetMult, item: it },
          });
          if ((data as any)?.ok) ok++; else fail++;
        } catch { fail++; }
      }
      toast({ title: "Expansão concluída", description: `${ok} criadas, ${fail} falharam.` });
      await loadPreview();
      await loadCreated();
      if (ok > 0) setTab("created");
    } finally { setBulkCreating(false); }
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

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <Field label="ROI mín. (%)" value={minRoi} onBlur={(v) => { setMinRoi(v); persist({ geo_expansion_min_roi_pct: v }); }} />
        <Field label="Custo mín. campanha (R$)" value={minCampCost} onBlur={(v) => { setMinCampCost(v); persist({ geo_expansion_min_campaign_cost_brl: v }); }} />
        <Field label="Custo mín. país (R$)" value={minCountryCost} onBlur={(v) => { setMinCountryCost(v); persist({ geo_expansion_min_country_cost_brl: v }); }} />
        <Field label="Mín. países" value={minCountries} onBlur={(v) => { setMinCountries(v); persist({ geo_expansion_min_countries: v }); }} />
        <Field label="Janela (dias)" value={lookback} onBlur={(v) => { setLookback(v); persist({ geo_expansion_lookback_days: v }); }} />
        <Field label="Intervalo cron (dias)" value={interval} onBlur={(v) => { setIntervalDays(v); persist({ geo_expansion_interval_days: v }); }} />
        <Field label="Multiplicador budget" value={budgetMult} step={0.05} onBlur={(v) => { setBudgetMult(v); persist({ geo_expansion_budget_multiplier: v }); }} />
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
            <Button onClick={loadPreview} disabled={loading || !siteId} className="gap-2">
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
            <p className="text-xs text-muted-foreground text-center py-4">
              Nenhum winner identificado ainda. Clique em "Buscar países vencedores" para analisar.
            </p>
          )}
        </>
      )}

      {tab === "created" && (
        <>
          <div className="flex items-center gap-2">
            <Button onClick={loadCreated} disabled={loadingCreated} variant="outline" size="sm" className="gap-2">
              {loadingCreated ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Atualizar
            </Button>
            <span className="text-xs text-muted-foreground">
              Histórico de campanhas winner duplicadas (sempre criadas em <strong>PAUSED</strong>).
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
                        <Badge variant={c.status === "executed" ? "default" : "secondary"}>{c.status}</Badge>
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
