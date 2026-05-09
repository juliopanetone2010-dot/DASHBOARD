import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface FreshnessRow { source: string; at: Date | null; status: string }

function fmtAge(d: Date | null) {
  if (!d) return "—";
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins}min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function colorFor(d: Date | null, status?: string) {
  if (status === "error") return "text-danger";
  if (!d) return "text-muted-foreground";
  const mins = (Date.now() - d.getTime()) / 60_000;
  if (mins < 60) return "text-success";
  if (mins < 360) return "text-warning";
  return "text-danger";
}

export function SyncStatusBar() {
  const { data } = useQuery({
    queryKey: ["sync-status-bar"],
    queryFn: async (): Promise<FreshnessRow[]> => {
      // 1) freshness inferida das tabelas (sempre confiável)
      const [adsRes, gamRes] = await Promise.all([
        supabase.from("daily_metrics").select("updated_at").order("updated_at", { ascending: false }).limit(1),
        supabase.from("gam_placement_revenue").select("created_at").order("created_at", { ascending: false }).limit(1),
      ]);
      const adsAt = adsRes.data?.[0]?.updated_at ? new Date(adsRes.data[0].updated_at) : null;
      const gamAt = gamRes.data?.[0]?.created_at ? new Date(gamRes.data[0].created_at) : null;
      // 2) status do último sync_state (opcional — best-effort)
      const { data: ss } = await supabase.from("sync_state").select("source,last_finished_at,last_status").limit(20);
      const ssMap = new Map<string, { at: Date | null; status: string }>();
      for (const r of ss ?? []) {
        const at = r.last_finished_at ? new Date(r.last_finished_at) : null;
        const cur = ssMap.get(r.source);
        if (!cur || (cur.at && at && at > cur.at)) ssMap.set(r.source, { at, status: r.last_status });
      }
      return [
        { source: "Google Ads", at: adsAt, status: ssMap.get("manual_refresh")?.status ?? "ok" },
        { source: "GAM", at: gamAt, status: "ok" },
      ];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const rows = data ?? [];
  if (!rows.length) return null;

  return (
    <div className="flex items-center gap-3 text-xs flex-wrap">
      {rows.map((r) => {
        const c = colorFor(r.at, r.status);
        const Icon = r.status === "error" ? AlertTriangle : r.at ? CheckCircle2 : Clock;
        return (
          <div key={r.source} className={cn("flex items-center gap-1.5", c)}>
            <Icon className="h-3.5 w-3.5" />
            <span className="font-medium">{r.source}:</span>
            <span className="tabular-nums">{fmtAge(r.at)}</span>
          </div>
        );
      })}
    </div>
  );
}
