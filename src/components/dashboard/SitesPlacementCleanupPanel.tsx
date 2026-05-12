import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type Site = { id: string; name: string };
type Link = { google_account_id: string; site_id: string };
type Cfg = {
  id?: string;
  site_id: string;
  google_account_id: string;
  automation_enabled: boolean;
  automation_dry_run: boolean;
  interval_days: number;
  last_run_at: string | null;
};

type Row = {
  site: Site;
  accounts: string[];
  enabled: boolean;
  dryRun: boolean;
  intervalDays: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
};

export function SitesPlacementCleanupPanel({ userId }: { userId: string | null }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [cfgs, setCfgs] = useState<Cfg[]>([]);

  const load = async () => {
    setLoading(true);
    const [{ data: sts }, { data: lks }, { data: pc }] = await Promise.all([
      supabase.from("sites").select("id, name").order("name"),
      supabase.from("account_site_links").select("google_account_id, site_id"),
      supabase.from("site_placement_config").select("id, site_id, google_account_id, automation_enabled, automation_dry_run, interval_days, last_run_at"),
    ]);
    setSites((sts ?? []) as Site[]);
    setLinks((lks ?? []) as Link[]);
    setCfgs((pc ?? []) as Cfg[]);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const rows: Row[] = useMemo(() => {
    return sites.map((site) => {
      const accounts = links.filter((l) => l.site_id === site.id).map((l) => l.google_account_id);
      const siteCfgs = cfgs.filter((c) => c.site_id === site.id && accounts.includes(c.google_account_id));
      const enabled = accounts.length > 0 && accounts.every((a) => siteCfgs.find((c) => c.google_account_id === a)?.automation_enabled);
      const dryRun = siteCfgs.some((c) => c.automation_dry_run);
      const intervals = siteCfgs.map((c) => Number(c.interval_days ?? 15)).filter((n) => n > 0);
      const intervalDays = intervals.length ? Math.max(...intervals) : 15;
      const lastRuns = siteCfgs.map((c) => c.last_run_at ? new Date(c.last_run_at).getTime() : 0).filter((n) => n > 0);
      const lastRunAt = lastRuns.length ? new Date(Math.min(...lastRuns)) : null;
      const nextRunAt = lastRunAt ? new Date(lastRunAt.getTime() + intervalDays * 86400_000) : (enabled ? new Date() : null);
      return { site, accounts, enabled, dryRun, intervalDays, lastRunAt, nextRunAt };
    });
  }, [sites, links, cfgs]);

  const upsert = async (row: Row, patch: Partial<Pick<Cfg, "automation_enabled" | "automation_dry_run" | "interval_days">>) => {
    if (!userId) return;
    if (row.accounts.length === 0) {
      toast({ title: "Sem contas vinculadas", description: "Vincule contas Google Ads a este site primeiro.", variant: "destructive" });
      return;
    }
    setSaving(row.site.id);
    const payload = row.accounts.map((accountId) => ({
      user_id: userId,
      site_id: row.site.id,
      google_account_id: accountId,
      automation_enabled: patch.automation_enabled ?? row.enabled,
      automation_dry_run: patch.automation_dry_run ?? row.dryRun,
      interval_days: patch.interval_days ?? row.intervalDays,
    }));
    const { error } = await supabase
      .from("site_placement_config")
      .upsert(payload, { onConflict: "user_id,site_id,google_account_id" });
    setSaving(null);
    if (error) toast({ title: "Erro", description: error.message, variant: "destructive" });
    else { toast({ title: "Configuração salva" }); await load(); }
  };

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando…</div>;

  const fmtDate = (d: Date | null) => d ? d.toLocaleDateString("pt-BR") : "—";

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Limpeza automática de placements por site</h3>
          <p className="text-sm text-muted-foreground">Cron diário às 05:00 BRT roda a avaliação inteligente nos sites ativos, respeitando o intervalo de cada um.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>Atualizar</Button>
      </div>
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.site.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
            <div className="flex-1 min-w-[220px]">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium truncate">{row.site.name}</span>
                {row.enabled
                  ? <Badge className="bg-success/15 text-success">Ativa</Badge>
                  : <Badge variant="outline">Inativa</Badge>}
                {row.dryRun && row.enabled && <Badge variant="secondary">Dry-run</Badge>}
                {row.accounts.length === 0 && <Badge variant="destructive">Sem contas</Badge>}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {row.accounts.length} conta(s) · última: {fmtDate(row.lastRunAt)} · próxima: {row.enabled ? fmtDate(row.nextRunAt) : "—"}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Intervalo</span>
              <Input
                type="number" min={1} max={90}
                value={row.intervalDays}
                disabled={saving === row.site.id || row.accounts.length === 0}
                className="w-20 h-8"
                onChange={(e) => {
                  const v = Math.max(1, Math.min(90, Number(e.target.value) || 15));
                  setCfgs((prev) => prev.map((c) => c.site_id === row.site.id ? { ...c, interval_days: v } : c));
                }}
                onBlur={(e) => {
                  const v = Math.max(1, Math.min(90, Number(e.target.value) || 15));
                  if (v !== row.intervalDays) upsert(row, { interval_days: v });
                }}
              />
              <span className="text-xs text-muted-foreground">dias</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Dry-run</span>
              <Switch
                checked={row.dryRun}
                disabled={saving === row.site.id || row.accounts.length === 0}
                onCheckedChange={(v) => upsert(row, { automation_dry_run: v })}
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Ativa</span>
              <Switch
                checked={row.enabled}
                disabled={saving === row.site.id || row.accounts.length === 0}
                onCheckedChange={(v) => upsert(row, { automation_enabled: v })}
              />
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="px-5 py-6 text-sm text-muted-foreground">Nenhum site cadastrado.</div>}
      </div>
    </div>
  );
}
