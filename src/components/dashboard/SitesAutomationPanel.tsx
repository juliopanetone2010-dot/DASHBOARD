import { useEffect, useMemo, useState } from "react";
import { Loader2, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type Site = { id: string; name: string };
type Link = { google_account_id: string; site_id: string };
type SiteAuto = {
  site_id: string;
  google_account_id: string;
  automation_enabled: boolean;
  automation_enabled_at: string | null;
  automation_dry_run: boolean;
};

type SiteRow = {
  site: Site;
  accounts: string[]; // google_account_ids vinculadas
  enabled: boolean;
  enabledAt: Date | null;
  dryRun: boolean;
};

const fmtBRL = (n: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 }).format(n || 0);

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

export function SitesAutomationPanel({ userId }: { userId: string | null }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [siteAuto, setSiteAuto] = useState<SiteAuto[]>([]);
  // mapa site_id -> { before, after, ongoing? }
  const [revenueImpact, setRevenueImpact] = useState<Record<string, { before: number; after: number; days: number; ongoing: boolean }>>({});

  const load = async () => {
    setLoading(true);
    const [{ data: sts }, { data: lks }, { data: sac }] = await Promise.all([
      supabase.from("sites").select("id, name").order("name"),
      supabase.from("account_site_links").select("google_account_id, site_id"),
      supabase.from("site_automation_config").select("site_id, google_account_id, automation_enabled, automation_enabled_at, automation_dry_run"),
    ]);
    setSites((sts ?? []) as Site[]);
    setLinks((lks ?? []) as Link[]);
    setSiteAuto((sac ?? []) as SiteAuto[]);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const rows: SiteRow[] = useMemo(() => {
    return sites.map((site) => {
      const accounts = links.filter((l) => l.site_id === site.id).map((l) => l.google_account_id);
      const auto = siteAuto.filter((sa) => sa.site_id === site.id && accounts.includes(sa.google_account_id));
      const enabled = accounts.length > 0 && accounts.every((a) => auto.find((sa) => sa.google_account_id === a)?.automation_enabled);
      // pega o mais antigo enabled_at entre as contas
      const dates = auto
        .filter((sa) => sa.automation_enabled && sa.automation_enabled_at)
        .map((sa) => new Date(sa.automation_enabled_at as string).getTime());
      const enabledAt = dates.length ? new Date(Math.min(...dates)) : null;
      const dryRun = auto.some((sa) => sa.automation_dry_run);
      return { site, accounts, enabled, enabledAt, dryRun };
    });
  }, [sites, links, siteAuto]);

  // Carrega impacto de receita: compara MESMA quantidade de dias antes vs depois.
  // Ex: ativou ontem → 1 dia depois é comparado com 1 dia antes.
  // Após 7 dias, fixa em 7d antes vs 7d depois (resultado consolidado).
  useEffect(() => {
    const run = async () => {
      const enabledRows = rows.filter((r) => r.enabled && r.enabledAt);
      if (enabledRows.length === 0) { setRevenueImpact({}); return; }
      const result: Record<string, { before: number; after: number; days: number; ongoing: boolean }> = {};
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(0, 0, 0, 0);
      await Promise.all(enabledRows.map(async (r) => {
        const enabledAt = r.enabledAt as Date;
        const afterStart = new Date(enabledAt.getTime() + 86400_000);
        afterStart.setHours(0, 0, 0, 0);
        const window = 7;
        const daysAfter = Math.max(0, Math.min(window, Math.floor((yesterday.getTime() - afterStart.getTime()) / 86400_000) + 1));
        const compareDays = Math.max(1, daysAfter);
        const afterFrom = afterStart;
        const afterTo = new Date(afterStart.getTime() + (compareDays - 1) * 86400_000);
        const beforeTo = new Date(enabledAt.getTime() - 1 * 86400_000);
        const beforeFrom = new Date(beforeTo.getTime() - (compareDays - 1) * 86400_000);

        const fetchSiteRevenue = async (from: Date, to: Date) => {
          const { data } = await supabase
            .from("gam_placement_revenue")
            .select("revenue_usd, date")
            .eq("site_id", r.site.id)
            .gte("date", dateOnly(from))
            .lte("date", dateOnly(to));
          return (data ?? []).reduce((s: number, x: any) => s + Number(x.revenue_usd ?? 0), 0);
        };
        const [beforeUsd, afterUsd] = await Promise.all([
          fetchSiteRevenue(beforeFrom, beforeTo),
          daysAfter > 0 ? fetchSiteRevenue(afterFrom, afterTo) : Promise.resolve(0),
        ]);
        const { data: rate } = await supabase
          .from("exchange_rates")
          .select("rate")
          .eq("from_currency", "USD")
          .eq("to_currency", "BRL")
          .maybeSingle();
        const r2 = Number(rate?.rate ?? 5);
        result[r.site.id] = {
          before: beforeUsd * r2,
          after: afterUsd * r2,
          days: daysAfter,
          ongoing: daysAfter >= window,
        };
      }));
      setRevenueImpact(result);
    };
    run();
  }, [rows]);

  const toggleSite = async (row: SiteRow, enable: boolean) => {
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
      automation_enabled: enable,
      automation_dry_run: row.dryRun,
    }));
    const { error } = await supabase.from("site_automation_config").upsert(payload, { onConflict: "user_id,site_id,google_account_id" });
    setSaving(null);
    if (error) toast({ title: "Erro", description: error.message, variant: "destructive" });
    else {
      toast({ title: enable ? `Automação ativada em ${row.site.name}` : `Automação desativada em ${row.site.name}` });
      await load();
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando sites…</div>;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Automação por site</h3>
          <p className="text-sm text-muted-foreground">Ative ou desative em cada site e veja o impacto na receita (7d antes vs 7d depois).</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>Atualizar</Button>
      </div>
      <div className="divide-y divide-border">
        {rows.map((row) => {
          const impact = revenueImpact[row.site.id];
          const delta = impact ? impact.after - impact.before : 0;
          const pct = impact && impact.before > 0 ? (delta / impact.before) * 100 : 0;
          const positive = delta > 0;
          const negative = delta < 0;
          const neutral = !impact || delta === 0;
          return (
            <div key={row.site.id} className="flex items-center gap-4 px-5 py-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium truncate">{row.site.name}</span>
                  {row.enabled
                    ? <Badge className="bg-success/15 text-success">Ativa</Badge>
                    : <Badge variant="outline">Inativa</Badge>}
                  {row.dryRun && row.enabled && <Badge variant="secondary">Dry-run</Badge>}
                  {row.accounts.length === 0 && <Badge variant="destructive">Sem contas</Badge>}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {row.accounts.length} conta(s) Google Ads vinculada(s)
                  {row.enabledAt && <> · ativa desde {row.enabledAt.toLocaleDateString("pt-BR")}</>}
                </div>
              </div>

              {/* Impacto */}
              <div className="hidden md:block min-w-[280px] text-right">
                {row.enabled && row.enabledAt ? (
                  impact ? (
                    <div className="space-y-0.5">
                      <div className="text-xs text-muted-foreground">
                        Receita 7d antes: <span className="font-mono">{fmtBRL(impact.before)}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Receita 7d depois: <span className="font-mono">{fmtBRL(impact.after)}</span>
                      </div>
                      <div className={cn(
                        "text-sm font-semibold flex items-center justify-end gap-1",
                        positive && "text-success",
                        negative && "text-destructive",
                        neutral && "text-muted-foreground",
                      )}>
                        {positive && <TrendingUp className="h-3.5 w-3.5" />}
                        {negative && <TrendingDown className="h-3.5 w-3.5" />}
                        {neutral && <Minus className="h-3.5 w-3.5" />}
                        {positive ? "+" : ""}{fmtBRL(delta)} ({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {impact.ongoing ? "Resultado consolidado (>7d)" : `Parcial — ${impact.days}/7 dias`}
                      </div>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">Calculando impacto…</span>
                  )
                ) : row.enabled && !row.enabledAt ? (
                  <span className="text-xs text-muted-foreground">Sem data de ativação registrada</span>
                ) : (
                  <span className="text-xs text-muted-foreground">Ative para medir o impacto</span>
                )}
              </div>

              <Switch
                checked={row.enabled}
                disabled={saving === row.site.id || row.accounts.length === 0}
                onCheckedChange={(v) => toggleSite(row, v)}
              />
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="px-5 py-6 text-sm text-muted-foreground">Nenhum site cadastrado.</div>
        )}
      </div>
    </div>
  );
}
