import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Play, Ban, RotateCcw, Sparkles, Filter } from "lucide-react";
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

interface Props { fxUsdBrl: number; }

type Status = "test" | "learning" | "good" | "bad" | "blocked";

interface Row {
  id: string;
  campaign_id: string;
  campaign_name: string | null;
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
  last_status_change_at: string;
}

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
  const [lookback, setLookback] = useState(30);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const loadConfig = async () => {
    const { data } = await supabase
      .from("rules_config")
      .select("placement_auto_cleanup_enabled, placement_cleanup_last_run_at")
      .maybeSingle();
    if (data) {
      setAutoEnabled(!!data.placement_auto_cleanup_enabled);
      setLastRun(data.placement_cleanup_last_run_at ?? null);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("placement_status")
        .select("id, campaign_id, campaign_name, placement, placement_type, status, phase, reason, priority, manual_override, cost_total, revenue_total, profit_total, roi_pct, clicks_total, impressions_total, conversions_total, first_seen_at, last_status_change_at")
        .order("cost_total", { ascending: false })
        .limit(5000);
      if (error) throw error;
      setRows((data ?? []) as Row[]);
    } catch (e: any) {
      toast({ title: "Erro ao carregar", description: e.message, variant: "destructive" });
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); loadConfig(); }, []);

  const toggleAuto = async (on: boolean) => {
    setAutoEnabled(on);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return;
    await supabase.from("rules_config").update({ placement_auto_cleanup_enabled: on }).eq("user_id", u.user.id);
    toast({ title: on ? "Esteira automática ligada (diária)" : "Esteira automática desligada" });
  };

  const evaluateNow = async () => {
    setEvaluating(true);
    try {
      const { data, error } = await supabase.functions.invoke<any>(
        "placements-evaluate",
        { body: { mode: "preview", lookback_days: lookback, fx_usd_brl: fxUsdBrl } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao avaliar", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      toast({ title: "Funil atualizado", description: `${data?.summary?.total ?? 0} placements analisados, ${data?.summary?.transitions ?? 0} mudanças de status` });
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

  const counts = useMemo(() => {
    const c = { all: rows.length, test: 0, learning: 0, good: 0, bad: 0, blocked: 0 } as any;
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => (filter === "all" || r.status === filter) &&
      (!s || r.placement.toLowerCase().includes(s) || (r.campaign_name ?? "").toLowerCase().includes(s)));
  }, [rows, filter, search]);

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
        <label className="text-[11px] text-muted-foreground flex items-center gap-1">
          Período
          <Input type="number" value={lookback} onChange={(e) => setLookback(Math.max(1, +e.target.value || 30))} className="h-7 w-16 text-xs" />
          <span className="text-[10px]">dias</span>
        </label>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/50">
          <Switch checked={autoEnabled} onCheckedChange={toggleAuto} />
          <div className="text-xs">
            <div className="font-medium">Esteira automática</div>
            <div className="text-muted-foreground text-[10px]">{lastRun ? `último: ${new Date(lastRun).toLocaleString("pt-BR")}` : "nunca executado"}</div>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={evaluateNow} disabled={evaluating}>
          {evaluating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : <RefreshCw className="h-3.5 w-3.5 mr-2" />}
          Avaliar agora
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
        <div className="flex-1 min-w-[220px] flex items-center gap-2 ml-auto">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filtrar por placement ou campanha..." className="h-8 text-xs" />
        </div>
      </div>

      <FunnelByCampaign
        rows={filtered}
        loading={loading}
        busyId={busyId}
        daysSince={daysSince}
        onBlock={(id, p) => updateStatus(id, "blocked", "force_block manual")}
        onSecondChance={(id) => updateStatus(id, "learning", "second_chance manual")}
        onReset={resetPlacement}
      />
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
