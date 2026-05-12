import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Clock, Loader2, RefreshCw, ShieldCheck, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

// Surface the soft-pause review queue produced by automation-run. Operators
// can intervene before the engine's 48h auto-revert fires: resume immediately,
// or "confirm pause" so the engine stops considering it for auto-revert.
//
// Backed by campaign_automation.auto_pause_state in
// ('pending_review' | 'auto_resumed' | 'exhausted_auto' | 'human_confirmed').
// "pending_review" → engine will auto-resume after review_at.
// "auto_resumed"   → engine already gave it one chance.
// "exhausted_auto" → engine paused it again; human-only from here.
// "human_confirmed"→ operator opted out of auto-revert.

const STATE_LABEL: Record<string, { text: string; cls: string }> = {
  pending_review: { text: "Aguardando revisão", cls: "bg-warning/15 text-warning" },
  auto_resumed:   { text: "Retomada automaticamente", cls: "bg-primary/15 text-primary" },
  exhausted_auto: { text: "Tentativas esgotadas", cls: "bg-destructive/15 text-destructive" },
  human_confirmed:{ text: "Confirmada por você", cls: "bg-muted text-muted-foreground" },
};

interface PausedRow {
  id: string;
  campaign_id: string;
  google_account_id: string;
  site_id: string;
  auto_paused_at: string | null;
  auto_paused_reason: string | null;
  auto_pause_review_at: string | null;
  auto_pause_snapshot: Record<string, unknown> | null;
  auto_pause_state: keyof typeof STATE_LABEL;
  auto_pause_resume_count: number | null;
  auto_pause_resumed_at: string | null;
}

interface CampaignMeta {
  campaign_id: string;
  name: string | null;
}

interface Props {
  siteId?: string; // optional filter; "all" or undefined → no filter
}

export function AutomationRollbackPanel({ siteId }: Props) {
  const [rows, setRows] = useState<PausedRow[] | null>(null);
  const [campNames, setCampNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, "resume" | "confirm" | null>>({});
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      let q = supabase
        .from("campaign_automation")
        .select(
          "id, campaign_id, google_account_id, site_id, auto_paused_at, auto_paused_reason, " +
          "auto_pause_review_at, auto_pause_snapshot, auto_pause_state, auto_pause_resume_count, auto_pause_resumed_at",
        )
        .not("auto_pause_state", "is", null)
        .order("auto_paused_at", { ascending: false })
        .limit(200);
      if (siteId && siteId !== "all") q = q.eq("site_id", siteId);
      const { data, error } = await q;
      if (error) throw error;
      const list = ((data ?? []) as unknown as PausedRow[]).filter((r) => !!r.auto_pause_state);
      setRows(list);
      const ids = [...new Set(list.map((r) => r.campaign_id))];
      if (ids.length) {
        const { data: camps } = await supabase
          .from("campaigns")
          .select("campaign_id, name")
          .in("campaign_id", ids);
        const map: Record<string, string> = {};
        for (const c of (camps ?? []) as CampaignMeta[]) {
          if (c.name) map[c.campaign_id] = c.name;
        }
        setCampNames(map);
      }
    } catch (e: any) {
      toast({ title: "Erro ao carregar fila de pausas", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [siteId]);

  const setRowBusy = (id: string, kind: "resume" | "confirm" | null) =>
    setBusy((b) => ({ ...b, [id]: kind }));

  const resumeNow = async (row: PausedRow) => {
    setRowBusy(row.id, "resume");
    try {
      const { data, error } = await supabase.functions.invoke("google-ads-mutate", {
        body: {
          action: "set_status",
          status: "ENABLED",
          campaign_id: row.campaign_id,
          google_account_id: row.google_account_id,
          site_id: row.site_id,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      const now = new Date().toISOString();
      // Cast: the new auto_pause_* columns ship in migration
      // 20260512101512_campaign_automation_soft_pause; Supabase auto-types
      // catch up after the next types regen post-deploy. Cast can be dropped then.
      await supabase
        .from("campaign_automation")
        .update({
          // human override: don't auto-revert again — operator owns this campaign now.
          auto_pause_state: "human_confirmed",
          auto_pause_resumed_at: now,
        } as any)
        .eq("id", row.id);

      await supabase.from("automation_logs").insert({
        user_id: (await supabase.auth.getUser()).data.user?.id ?? null,
        site_id: row.site_id,
        google_account_id: row.google_account_id,
        campaign_id: row.campaign_id,
        action: "manual_resume",
        reason: "Operador retomou manualmente a campanha pela tela de revisão.",
        decision: "executed",
        payload: { previous_state: row.auto_pause_state },
      });

      toast({ title: "Campanha retomada", description: `${campNames[row.campaign_id] ?? row.campaign_id} voltou a rodar.` });
      await load();
    } catch (e: any) {
      toast({ title: "Falha ao retomar", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setRowBusy(row.id, null);
    }
  };

  const confirmPause = async (row: PausedRow) => {
    setRowBusy(row.id, "confirm");
    try {
      // Cast: see note in resumeNow above.
      await supabase
        .from("campaign_automation")
        .update({ auto_pause_state: "human_confirmed" } as any)
        .eq("id", row.id);

      await supabase.from("automation_logs").insert({
        user_id: (await supabase.auth.getUser()).data.user?.id ?? null,
        site_id: row.site_id,
        google_account_id: row.google_account_id,
        campaign_id: row.campaign_id,
        action: "manual_confirm_pause",
        reason: "Operador confirmou a pausa; a auto-retomada não será mais aplicada.",
        decision: "executed",
        payload: { previous_state: row.auto_pause_state },
      });

      toast({ title: "Pausa confirmada", description: "A automação não vai mais tentar retomar essa campanha." });
      await load();
    } catch (e: any) {
      toast({ title: "Erro", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setRowBusy(row.id, null);
    }
  };

  const fmtDateTime = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  const fmtReviewIn = (iso: string | null) => {
    if (!iso) return "—";
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "vencido (qualquer hora)";
    const hours = Math.round(ms / 3600_000);
    if (hours < 24) return `em ~${hours}h`;
    return `em ~${Math.round(hours / 24)}d`;
  };

  const groups = useMemo(() => {
    const g: Record<string, PausedRow[]> = { pending_review: [], exhausted_auto: [], auto_resumed: [], human_confirmed: [] };
    for (const r of rows ?? []) (g[r.auto_pause_state] ??= []).push(r);
    return g;
  }, [rows]);

  if (rows === null) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 shadow-elegant">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando fila de pausas…
        </div>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 shadow-elegant">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-success" />
            <h3 className="text-sm font-semibold">Pausas automáticas</h3>
            <span className="text-xs text-muted-foreground">Nenhuma campanha em revisão.</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={refreshing} className="gap-1.5 h-8">
            <RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          </Button>
        </div>
      </section>
    );
  }

  const renderGroup = (state: keyof typeof STATE_LABEL, list: PausedRow[]) => {
    if (!list.length) return null;
    const label = STATE_LABEL[state];
    return (
      <div key={state} className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge className={label.cls}>{label.text}</Badge>
          <span className="text-xs text-muted-foreground">{list.length} campanha(s)</span>
        </div>
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campanha</TableHead>
                <TableHead>Pausada em</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead>Snapshot</TableHead>
                <TableHead className="w-[200px]">{state === "pending_review" ? "Revisão" : "Status"}</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => {
                const snap = (r.auto_pause_snapshot ?? {}) as Record<string, any>;
                const roi = snap.roi == null ? "?" : `${Number(snap.roi).toFixed(1)}%`;
                const trend = snap.trend ?? "—";
                const days = snap.days_evaluated ?? "?";
                const showResume = state === "pending_review" || state === "exhausted_auto";
                const showConfirm = state === "pending_review";
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{campNames[r.campaign_id] ?? r.campaign_id}</TableCell>
                    <TableCell className="font-mono text-xs">{fmtDateTime(r.auto_paused_at)}</TableCell>
                    <TableCell className="text-xs max-w-[320px]">
                      <span className="line-clamp-2" title={r.auto_paused_reason ?? ""}>{r.auto_paused_reason ?? "—"}</span>
                    </TableCell>
                    <TableCell className="text-xs font-mono whitespace-nowrap">
                      ROI {roi} · {trend} · {days}d
                    </TableCell>
                    <TableCell className="text-xs">
                      {state === "pending_review" && (
                        <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {fmtReviewIn(r.auto_pause_review_at)}</span>
                      )}
                      {state === "auto_resumed" && (
                        <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-success" /> Retomada {fmtDateTime(r.auto_pause_resumed_at)}</span>
                      )}
                      {state === "exhausted_auto" && (
                        <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 text-destructive" /> Intervenção humana necessária</span>
                      )}
                      {state === "human_confirmed" && <span className="text-muted-foreground">Auto-retomada desligada</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {showResume && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void resumeNow(r)}
                            disabled={busy[r.id] === "resume"}
                            className="gap-1.5 h-8"
                          >
                            {busy[r.id] === "resume" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                            Retomar
                          </Button>
                        )}
                        {showConfirm && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void confirmPause(r)}
                            disabled={busy[r.id] === "confirm"}
                            className="gap-1.5 h-8"
                          >
                            {busy[r.id] === "confirm" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                            Confirmar pausa
                          </Button>
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
    );
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-elegant space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Undo2 className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Pausas automáticas (revisão e rollback)</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={refreshing} className="gap-1.5 h-8">
          <RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          Atualizar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Campanhas pausadas pela automação. Pendentes voltam sozinhas após 48h de observação;
        nesta tela você pode retomar antes do prazo ou confirmar a pausa pra desligar a auto-retomada.
      </p>
      {renderGroup("pending_review", groups.pending_review ?? [])}
      {renderGroup("exhausted_auto", groups.exhausted_auto ?? [])}
      {renderGroup("auto_resumed", groups.auto_resumed ?? [])}
      {renderGroup("human_confirmed", groups.human_confirmed ?? [])}
    </section>
  );
}
