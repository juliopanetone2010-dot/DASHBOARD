import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, RefreshCw, Bot, MapPin, Globe, Repeat, Rocket, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

type Row = {
  id: string;
  ts: string;
  source: string;
  action: string;
  campaign_id?: string | null;
  status?: string | null;
  reason?: string | null;
  detail?: string | null;
};

const SOURCES = [
  { key: "automation_logs", label: "Automação (lifecycle)", icon: Bot },
  { key: "automation_actions", label: "Automação (ações)", icon: Bot },
  { key: "campaign_funnel_logs", label: "Funil", icon: Sparkles },
  { key: "geo_cleanup_logs", label: "Geo cleanup", icon: Globe },
  { key: "campaign_expansion_logs", label: "Expansão geo", icon: Globe },
  { key: "placement_actions", label: "Placements", icon: MapPin },
  { key: "campaign_migrations", label: "Migração", icon: Repeat },
  { key: "campaign_restart_flow", label: "Restart", icon: Rocket },
];

async function fetchHistory(limit = 300): Promise<Row[]> {
  const out: Row[] = [];
  const q = (n: number) => n;

  const [
    autoLogs, autoActs, funnelLogs, geoLogs, expLogs, placeActs, migs, restarts,
  ] = await Promise.all([
    supabase.from("automation_logs").select("id, created_at, action, decision, reason, campaign_id, lifecycle_from, lifecycle_to, error").order("created_at", { ascending: false }).limit(q(limit)),
    supabase.from("automation_actions").select("id, created_at, action_type, status, reason, campaign_id, error").order("created_at", { ascending: false }).limit(q(limit)),
    supabase.from("campaign_funnel_logs").select("id, created_at, action, reason, campaign_id, status_from, status_to, dry_run, error").order("created_at", { ascending: false }).limit(q(limit)),
    supabase.from("geo_cleanup_logs").select("id, created_at, action, campaign_id, country_code, country_name, roi_pct").order("created_at", { ascending: false }).limit(q(limit)),
    supabase.from("campaign_expansion_logs").select("id, created_at, action, status, original_campaign_id, country_code, country_name, roi_pct, error").order("created_at", { ascending: false }).limit(q(limit)),
    supabase.from("placement_actions").select("id, created_at, action, status, reason, campaign_id, placement_key, error").order("created_at", { ascending: false }).limit(q(limit)),
    supabase.from("campaign_migrations").select("id, created_at, status, source_campaign_id, destination_campaign_id, error").order("created_at", { ascending: false }).limit(q(limit)),
    supabase.from("campaign_restart_flow").select("id, updated_at, stage, status, campaign_id, last_action, notes").order("updated_at", { ascending: false }).limit(q(limit)),
  ]);

  (autoLogs.data ?? []).forEach((r: any) => out.push({
    id: `al-${r.id}`, ts: r.created_at, source: "automation_logs",
    action: r.action, campaign_id: r.campaign_id, status: r.decision,
    reason: r.reason,
    detail: [r.lifecycle_from, r.lifecycle_to].filter(Boolean).join(" → ") || r.error,
  }));
  (autoActs.data ?? []).forEach((r: any) => out.push({
    id: `aa-${r.id}`, ts: r.created_at, source: "automation_actions",
    action: r.action_type, campaign_id: r.campaign_id, status: r.status,
    reason: r.reason, detail: r.error,
  }));
  (funnelLogs.data ?? []).forEach((r: any) => out.push({
    id: `fl-${r.id}`, ts: r.created_at, source: "campaign_funnel_logs",
    action: r.action, campaign_id: r.campaign_id,
    status: r.dry_run ? "dry-run" : "executed",
    reason: r.reason,
    detail: [r.status_from, r.status_to].filter(Boolean).join(" → ") || r.error,
  }));
  (geoLogs.data ?? []).forEach((r: any) => out.push({
    id: `gl-${r.id}`, ts: r.created_at, source: "geo_cleanup_logs",
    action: r.action, campaign_id: r.campaign_id,
    detail: `${r.country_code ?? ""} ${r.country_name ?? ""} • ROI ${r.roi_pct ?? "-"}%`,
  }));
  (expLogs.data ?? []).forEach((r: any) => out.push({
    id: `el-${r.id}`, ts: r.created_at, source: "campaign_expansion_logs",
    action: r.action, status: r.status, campaign_id: r.original_campaign_id,
    detail: `${r.country_code ?? ""} ${r.country_name ?? ""} • ROI ${r.roi_pct ?? "-"}% ${r.error ?? ""}`,
  }));
  (placeActs.data ?? []).forEach((r: any) => out.push({
    id: `pa-${r.id}`, ts: r.created_at, source: "placement_actions",
    action: r.action, status: r.status, reason: r.reason,
    campaign_id: r.campaign_id, detail: r.placement_key || r.error,
  }));
  (migs.data ?? []).forEach((r: any) => out.push({
    id: `mg-${r.id}`, ts: r.created_at, source: "campaign_migrations",
    action: "migration", status: r.status, campaign_id: r.source_campaign_id,
    detail: `→ ${r.destination_campaign_id ?? "?"} ${r.error ?? ""}`,
  }));
  (restarts.data ?? []).forEach((r: any) => out.push({
    id: `rs-${r.id}`, ts: r.updated_at, source: "campaign_restart_flow",
    action: r.last_action ?? r.stage, status: r.status,
    campaign_id: r.campaign_id, detail: r.notes,
  }));

  out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return out;
}

function statusVariant(s?: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (!s) return "outline";
  const x = s.toLowerCase();
  if (["executed", "approved", "active", "ok", "success", "applied"].some(k => x.includes(k))) return "default";
  if (["fail", "error", "rejected", "blocked"].some(k => x.includes(k))) return "destructive";
  if (["pending", "dry", "standby"].some(k => x.includes(k))) return "secondary";
  return "outline";
}

export function HistoryTab() {
  const { user } = useAuth();
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data: rows = [], isFetching, refetch } = useQuery({
    queryKey: ["history-unified", user?.id],
    queryFn: () => fetchHistory(300),
    enabled: !!user,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
      if (search.trim()) {
        const s = search.toLowerCase();
        const hay = [r.action, r.campaign_id, r.reason, r.detail, r.status].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [rows, sourceFilter, search]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach(r => { m[r.source] = (m[r.source] ?? 0) + 1; });
    return m;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-5 shadow-elegant">
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <History className="h-4 w-4" /> Histórico unificado
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Todas as ações executadas pelas automações, cleanup, funil, geo, migração e restart
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Atualizar
          </Button>
        </div>

        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as origens ({rows.length})</SelectItem>
              {SOURCES.map(s => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label} ({counts[s.key] ?? 0})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Buscar por campanha, ação, motivo…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Badge variant="outline">{filtered.length} eventos</Badge>
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12">
            {isFetching ? "Carregando…" : "Nenhum evento encontrado."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left py-2 px-2 font-medium">Quando</th>
                  <th className="text-left py-2 px-2 font-medium">Origem</th>
                  <th className="text-left py-2 px-2 font-medium">Ação</th>
                  <th className="text-left py-2 px-2 font-medium">Status</th>
                  <th className="text-left py-2 px-2 font-medium">Campanha</th>
                  <th className="text-left py-2 px-2 font-medium">Detalhes</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map(r => {
                  const src = SOURCES.find(s => s.key === r.source);
                  return (
                    <tr key={r.id} className="border-b border-border/40 hover:bg-muted/30">
                      <td className="py-2 px-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(r.ts).toLocaleString("pt-BR")}
                      </td>
                      <td className="py-2 px-2">
                        <Badge variant="secondary" className="text-[10px]">{src?.label ?? r.source}</Badge>
                      </td>
                      <td className="py-2 px-2 font-medium">{r.action ?? "-"}</td>
                      <td className="py-2 px-2">
                        {r.status ? <Badge variant={statusVariant(r.status)} className="text-[10px]">{r.status}</Badge> : <span className="text-muted-foreground">-</span>}
                      </td>
                      <td className="py-2 px-2 font-mono text-xs">{r.campaign_id ?? "-"}</td>
                      <td className="py-2 px-2 text-xs text-muted-foreground max-w-md truncate" title={[r.reason, r.detail].filter(Boolean).join(" • ")}>
                        {[r.reason, r.detail].filter(Boolean).join(" • ") || "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
