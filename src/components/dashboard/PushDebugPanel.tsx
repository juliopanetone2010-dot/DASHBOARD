import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bug, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  pushRows: Array<{ placement: string; raw_utm: string | null; utm_source: string | null; rev: number; impr: number }>;
  utms: Array<{ utm: string; rev: number; impr: number }>;
  totalRev: number;
  totalImpr: number;
  range: { from: string; to: string };
  siteId: string;
}

interface DbStats {
  totalRows: number;
  pushRows: number;
  unknownRows: number;
  distinctUrls: number;
  distinctUtms: string[];
  lastInsertAt: string | null;
  sampleUrls: string[];
}

export function PushDebugPanel({ pushRows, utms, totalRev, totalImpr, range, siteId }: Props) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      let q = supabase
        .from("gam_url_revenue")
        .select("url, utm_source, created_at")
        .gte("date", range.from)
        .lte("date", range.to)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (siteId !== "all") q = q.eq("site_id", siteId);
      const { data } = await q;
      const rows = (data ?? []).map((r: any) => ({ page_url: r.url, utm_source: r.utm_source, created_at: r.created_at }));
      const utmSet = new Set<string>();
      const urlSet = new Set<string>();
      let push = 0;
      let unknown = 0;
      for (const r of rows) {
        const u = String(r.utm_source ?? "unknown");
        utmSet.add(u);
        urlSet.add(r.page_url);
        if (u === "push") push++;
        if (u === "unknown") unknown++;
      }
      setStats({
        totalRows: rows.length,
        pushRows: push,
        unknownRows: unknown,
        distinctUrls: urlSet.size,
        distinctUtms: [...utmSet].sort(),
        lastInsertAt: rows[0]?.created_at ?? null,
        sampleUrls: [...urlSet].slice(0, 8),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && !stats) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Card className="border-dashed">
      <CardHeader className="cursor-pointer select-none" onClick={() => setOpen((v) => !v)}>
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Bug className="h-4 w-4" /> Push Debug {open ? "▾" : "▸"}
          </span>
          <Badge variant="outline" className="font-mono text-[10px]">{range.from} → {range.to}</Badge>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 text-xs font-mono">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Estado atual da aba</span>
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void load(); }} disabled={loading} className="h-7 gap-1">
              <RefreshCw className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} /> Recarregar
            </Button>
          </div>
          <ul className="space-y-1 rounded border border-border bg-muted/30 p-3">
            <li>UTMs distintas (cards): <b>{utms.length}</b></li>
            <li>Receita push (cards): <b>${totalRev.toFixed(2)}</b></li>
            <li>Impressões push (cards): <b>{totalImpr.toLocaleString("pt-BR")}</b></li>
            <li>URLs push retornadas (tabela): <b>{pushRows.length}</b></li>
            <li>Sample URL: <span className="text-muted-foreground">{pushRows[0]?.placement ?? "—"}</span></li>
          </ul>

          <div className="text-muted-foreground pt-2">Banco — push_url_revenue</div>
          {!stats ? (
            <p className="text-muted-foreground">Clique em recarregar para ler do banco.</p>
          ) : (
            <ul className="space-y-1 rounded border border-border bg-muted/30 p-3">
              <li>Rows totais no período: <b>{stats.totalRows}</b></li>
              <li>Rows utm_source=push: <b>{stats.pushRows}</b></li>
              <li>Rows utm_source=unknown: <b>{stats.unknownRows}</b></li>
              <li>URLs distintas: <b>{stats.distinctUrls}</b></li>
              <li>UTMs vistas: <b>[{stats.distinctUtms.join(", ") || "—"}]</b></li>
              <li>Último insert: <b>{stats.lastInsertAt ?? "—"}</b></li>
              {stats.sampleUrls.length > 0 && (
                <li className="pt-1">
                  Sample URLs:
                  <ul className="ml-4 list-disc text-muted-foreground">
                    {stats.sampleUrls.map((u) => <li key={u} className="truncate">{u}</li>)}
                  </ul>
                </li>
              )}
            </ul>
          )}

          <div className="text-muted-foreground pt-2">Checklist no site (DevTools)</div>
          <pre className="rounded border border-border bg-muted/30 p-3 whitespace-pre-wrap">
{`googletag.pubads().getTargetingKeys()
  // => ["page_url","utm_source","utm_campaign","site_slug"]
googletag.pubads().getTargeting("utm_source")
  // => ["push"] em /?utm_source=push
googletag.pubads().getTargeting("page_url")
  // => ["host/path"]`}
          </pre>
          {stats && stats.totalRows === 0 && (
            <p className="text-amber-500">
              ⚠ Nenhuma linha no banco. Ou o snippet não está ativo, ou as keys não estão Reportable no GAM, ou o cron ainda não rodou.
            </p>
          )}
          {stats && stats.totalRows > 0 && stats.pushRows === 0 && (
            <p className="text-amber-500">
              ⚠ Há linhas no banco mas nenhuma com utm_source=push. O snippet está rodando mas a key utm_source não está chegando como "push" nos slots disparados.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
