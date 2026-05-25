import { useState } from "react";
import { Loader2, ShieldCheck, AlertTriangle, AlertOctagon, Zap, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type Method = "exact_utm_placement" | "campaign_placement" | "normalized_url" | "inferred" | "unknown";

interface LeakRow {
  campaign_id: string;
  campaign_revenue_usd: number;
  reconciled_revenue_usd: number;
  exact_revenue_usd: number;
  exact_share_pct: number;
  leak_amount_usd: number;
  leak_percent: number;
  status: "verified" | "partial" | "leak_detected" | "unreliable" | "broken";
}

interface RebuildReport {
  ok: boolean;
  period: { from: string; to: string };
  source_rows: number;
  reconciled_rows: number;
  method_breakdown: Record<Method, number>;
  exact_utm_placement_pct: number;
  broken_tracking_rows: number;
  aggregate_orphan_revenue_usd?: number;
  revenue_sources?: Record<string, any>;
  reconciled_vs_total?: string;
  total_gam_revenue_usd?: number;
  total_reconciled_revenue_usd?: number;
  global_leak_percent?: number;
  campaign_match_pct?: number;
  raw_samples?: Array<Record<string, any>>;
  top_unreconciled_rows?: Array<Record<string, any>>;
  report_origin?: Record<string, string>;
  leak_report: LeakRow[];
  summary: Record<string, number>;
}

const STATUS_BADGE: Record<LeakRow["status"], { label: string; cls: string }> = {
  verified: { label: "VERIFIED", cls: "bg-success/15 text-success border-success/30" },
  partial: { label: "PARTIAL", cls: "bg-warning/15 text-warning border-warning/30" },
  leak_detected: { label: "LEAK", cls: "bg-destructive/15 text-destructive border-destructive/30" },
  unreliable: { label: "UNRELIABLE", cls: "bg-destructive/15 text-destructive border-destructive/30" },
  broken: { label: "BROKEN", cls: "bg-foreground/10 text-foreground border-foreground/30" },
};

export function AttributionAuditTab() {
  const [period, setPeriod] = useState<"7d" | "15d">("7d");
  const [paranoid, setParanoid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<RebuildReport | null>(null);

  const runRebuild = async () => {
    setLoading(true);
    setReport(null);
    const days = period === "7d" ? 6 : 14;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const { data, error } = await supabase.functions.invoke("rebuild-canonical-placement-engine", {
      body: { period_start: fmt(start), period_end: fmt(end), tolerance_pct: paranoid ? 1 : 3 },
    });
    setLoading(false);
    if (error) {
      toast({ title: "Falha no rebuild", description: error.message, variant: "destructive" });
      return;
    }
    setReport(data as RebuildReport);
    toast({ title: "Rebuild concluído", description: `${data.reconciled_rows} linhas reconciliadas` });
  };

  // Métricas globais
  const totalRows = report?.source_rows ?? 0;
  const exactPct = report?.exact_utm_placement_pct ?? 0;
  const brokenPct = totalRows ? ((report?.broken_tracking_rows ?? 0) / totalRows) * 100 : 0;
  const inferredCount = (report?.method_breakdown?.inferred ?? 0) + (report?.method_breakdown?.normalized_url ?? 0);
  const inferredPct = totalRows ? (inferredCount / totalRows) * 100 : 0;

  const verifiedCampaigns = report?.summary?.verified ?? 0;
  const totalCampaigns = report?.leak_report?.length ?? 0;
  const campaignMatchPct = report?.campaign_match_pct ?? (totalCampaigns ? (verifiedCampaigns / totalCampaigns) * 100 : 0);

  const totalGam = report?.total_gam_revenue_usd ?? (report?.leak_report.reduce((s, r) => s + r.campaign_revenue_usd, 0) ?? 0);
  const totalReconciled = report?.total_reconciled_revenue_usd ?? (report?.leak_report.reduce((s, r) => s + r.reconciled_revenue_usd, 0) ?? 0);
  const globalLeak = report?.global_leak_percent ?? (totalGam > 0 ? ((totalGam - totalReconciled) / totalGam) * 100 : 0);

  // Top leaks
  const topLeaks = [...(report?.leak_report ?? [])]
    .sort((a, b) => Math.abs(b.leak_amount_usd) - Math.abs(a.leak_amount_usd))
    .slice(0, 10);

  const metaGood = (val: number, target: number, gt = true) =>
    gt ? val >= target : val <= target;

  return (
    <div className="space-y-6">
      {/* Header / controls */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5" /> Attribution Audit
          </h2>
          <p className="text-sm text-muted-foreground">
            Reconcilia <code className="text-xs">gam_placement_revenue</code> usando <code className="text-xs">utm_placement={'{'}campaignid{'}_{'}placement{'}'}</code> como source of truth.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Tabs value={period} onValueChange={(v) => setPeriod(v as any)}>
            <TabsList>
              <TabsTrigger value="7d">Últimos 7 dias</TabsTrigger>
              <TabsTrigger value="15d">Últimos 15 dias</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">PARANOID</span>
            <Switch checked={paranoid} onCheckedChange={setParanoid} />
          </div>
          <Button onClick={runRebuild} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
            Rebuild canonical engine
          </Button>
        </div>
      </div>

      {!report && !loading && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          Clique em <span className="font-medium text-foreground">Rebuild canonical engine</span> para auditar a attribution dos últimos {period === "7d" ? 7 : 15} dias.
          <div className="mt-4 text-xs">Hard validation antes de plugar no cleanup automático.</div>
        </Card>
      )}

      {loading && (
        <Card className="p-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Reconstruindo canonical engine…
        </Card>
      )}

      {report && (
        <>
          {/* Metas */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetaCard
              label="Campaign match"
              value={`${campaignMatchPct.toFixed(1)}%`}
              meta="≥ 97%"
              ok={metaGood(campaignMatchPct, 97)}
            />
            <MetaCard
              label="Exact utm_placement"
              value={`${exactPct.toFixed(1)}%`}
              meta="≥ 90%"
              ok={metaGood(exactPct, 90)}
            />
            <MetaCard
              label="Broken tracking"
              value={`${brokenPct.toFixed(1)}%`}
              meta="< 3%"
              ok={metaGood(brokenPct, 3, false)}
            />
            <MetaCard
              label="Leak global"
              value={`${Math.abs(globalLeak).toFixed(1)}%`}
              meta="< 3%"
              ok={metaGood(Math.abs(globalLeak), 3, false)}
            />
          </div>

          {/* Breakdown geral */}
          <Card className="p-5">
            <h3 className="font-semibold mb-3">Breakdown global ({report.period.from} → {report.period.to})</h3>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
              <Stat label="Rows GAM" value={report.source_rows.toLocaleString()} />
              <Stat label="Reconciled" value={report.reconciled_rows.toLocaleString()} />
              <Stat label="GAM revenue" value={`$${totalGam.toFixed(2)}`} />
              <Stat label="Reconciled rev" value={`$${totalReconciled.toFixed(2)}`} />
              <Stat label="Reconciled vs total" value={report.reconciled_vs_total ?? `$${totalReconciled.toFixed(2)} / $${totalGam.toFixed(2)}`} accent={Math.abs(globalLeak) <= 3 ? "success" : "warning"} />
              <Stat label="Aggregate" value={`$${(report.aggregate_orphan_revenue_usd ?? 0).toFixed(2)}`} accent={(report.aggregate_orphan_revenue_usd ?? 0) > 0 ? "warning" : undefined} />
              <Stat label="Exact rows" value={`${(report.method_breakdown.exact_utm_placement ?? 0)}`} accent="success" />
              <Stat label="Inferred/URL" value={`${inferredCount} (${inferredPct.toFixed(1)}%)`} accent="warning" />
            </div>

            {report.report_origin && (
              <div className="mt-4 rounded border border-warning/30 bg-warning/10 p-3 text-xs text-muted-foreground space-y-1">
                <div><strong className="text-foreground">Root cause provável:</strong> {report.report_origin.aggregate_root_cause}</div>
                <div><strong className="text-foreground">Report aggregate:</strong> {report.report_origin.campaign_report}</div>
                <div><strong className="text-foreground">Report placement:</strong> {report.report_origin.placement_report}</div>
              </div>
            )}

            {/* Method breakdown bar */}
            <div className="mt-4">
              <div className="flex h-3 rounded overflow-hidden bg-muted">
                {Object.entries(report.method_breakdown).map(([m, n]) => {
                  const pct = totalRows ? (n / totalRows) * 100 : 0;
                  const color =
                    m === "exact_utm_placement" ? "bg-success" :
                    m === "campaign_placement" ? "bg-primary" :
                    m === "normalized_url" ? "bg-warning" :
                    m === "inferred" ? "bg-destructive" : "bg-muted-foreground";
                  return <div key={m} className={color} style={{ width: `${pct}%` }} title={`${m}: ${n} (${pct.toFixed(1)}%)`} />;
                })}
              </div>
              <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted-foreground">
                {Object.entries(report.method_breakdown).map(([m, n]) => (
                  <span key={m}>
                    <strong className="text-foreground">{m}</strong>: {n} ({((n / totalRows) * 100 || 0).toFixed(1)}%)
                  </span>
                ))}
              </div>
            </div>
          </Card>

          {/* Status summary */}
          <Card className="p-5">
            <h3 className="font-semibold mb-3">Status das campanhas ({totalCampaigns})</h3>
            <div className="flex flex-wrap gap-2">
              {(["verified", "partial", "leak_detected", "unreliable", "broken"] as const).map((s) => {
                const cnt = report.summary[s] ?? 0;
                const b = STATUS_BADGE[s];
                return (
                  <Badge key={s} variant="outline" className={b.cls}>
                    {b.label}: {cnt}
                  </Badge>
                );
              })}
            </div>
          </Card>

          {/* Top leaks */}
          <Card className="p-5">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" /> Top leaks
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead className="text-right">GAM rev</TableHead>
                  <TableHead className="text-right">Reconciled</TableHead>
                  <TableHead className="text-right">Exact</TableHead>
                  <TableHead className="text-right">Exact %</TableHead>
                  <TableHead className="text-right">Leak %</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topLeaks.map((r) => {
                  const b = STATUS_BADGE[r.status];
                  return (
                    <TableRow key={r.campaign_id}>
                      <TableCell className="font-mono text-xs">{r.campaign_id}</TableCell>
                      <TableCell className="text-right">${r.campaign_revenue_usd.toFixed(2)}</TableCell>
                      <TableCell className="text-right">${r.reconciled_revenue_usd.toFixed(2)}</TableCell>
                      <TableCell className="text-right">${r.exact_revenue_usd.toFixed(2)}</TableCell>
                      <TableCell className="text-right">{r.exact_share_pct.toFixed(1)}%</TableCell>
                      <TableCell className={`text-right ${Math.abs(r.leak_percent) > 10 ? "text-destructive font-semibold" : ""}`}>
                        {r.leak_percent.toFixed(1)}%
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={b.cls}>{b.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {topLeaks.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">Sem campanhas no período.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>

          {/* Hard validation gate */}
          <Card className="p-5">
            <div className="flex items-start gap-3">
              {campaignMatchPct >= 97 && exactPct >= 90 && Math.abs(globalLeak) < 3 && brokenPct < 3 ? (
                <>
                  <ShieldCheck className="h-6 w-6 text-success flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-success">Engine APROVADA para cleanup automático</div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Todas as metas atingidas. Pode plugar GlobalPlacementCleanup em <code className="text-xs">placement_revenue_reconciled</code> filtrando por <code className="text-xs">reconciliation_method='exact_utm_placement'</code>.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <AlertOctagon className="h-6 w-6 text-destructive flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-destructive">Engine NÃO aprovada — cleanup deve excluir SÓ VERIFIED</div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Enquanto as metas não baterem, automação não pode excluir <strong>PARTIAL / LEAK / BROKEN / ESTIMATED</strong>.
                      Corrija Final URL Suffix do Google Ads para <code className="text-xs">utm_placement={'{'}campaignid{'}_{'}placement{'}'}</code> e re-rode o rebuild.
                    </p>
                  </div>
                </>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function MetaCard({ label, value, meta, ok }: { label: string; value: string; meta: string; ok: boolean }) {
  return (
    <Card className={`p-4 ${ok ? "border-success/40" : "border-destructive/40"}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${ok ? "text-success" : "text-destructive"}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground mt-1">Meta: {meta}</div>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "success" | "warning" }) {
  const color = accent === "success" ? "text-success" : accent === "warning" ? "text-warning" : "text-foreground";
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold ${color}`}>{value}</div>
    </div>
  );
}
