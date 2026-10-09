// Aba Facebook: gasto da Meta (fb_ad_daily, via meta-ads-sync) × receita do GAM (gam_campaign_source_revenue,
// campaign_id = ID da campanha do Facebook vindo do utm_campaign) → lucro e ROI por campanha e por dia.
// Tudo em USD: a Meta cobra em USD (C1) e o GAM grava revenue_usd. Conta em BRL é convertida com fxUsdBrl.
// Com um site escolhido no topo, só entram as contas da Meta ligadas a ele (fb_ad_accounts.site_id) e a receita do GAM desse site.
// A receita só existe por campanha (o gam-sync não lê utm_content), então os anúncios mostram só gasto/cliques.
import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Wallet, TrendingUp, DollarSign, Percent, ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fmtUSD, fmtNumber, fmtPercent } from "@/lib/format";
import { getRevSharePct } from "@/lib/revshare";
import { DATE_PRESETS, type DatePresetKey } from "@/components/dashboard/FilterBar";
import { MetricCard } from "./MetricCard";
import { toast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

interface FbAccount { id: string; ad_account_id: string; name: string | null; currency: string; site_id: string | null; last_sync_at: string | null; last_sync_error: string | null }
interface FbRow { ad_account_id: string; date: string; campaign_id: string; campaign_name: string | null; ad_id: string; ad_name: string | null; spend: number; impressions: number; link_clicks: number; landing_page_views: number }
interface RevRow { site_id: string; campaign_id: string; date: string; revenue_usd: number; impressions: number }

interface Agg { spend: number; impressions: number; clicks: number; lpv: number; revenue: number }
const emptyAgg = (): Agg => ({ spend: 0, impressions: 0, clicks: 0, lpv: 0, revenue: 0 });
const roi = (a: Agg) => (a.spend > 0 ? ((a.revenue - a.spend) / a.spend) * 100 : 0);

const PRESET_KEYS: DatePresetKey[] = ["today", "yesterday", "yesterday_today", "last_3_days", "last_7_days", "last_30_days"];

export function FacebookTab({ fxUsdBrl, siteId = "all" }: { fxUsdBrl: number; siteId?: string }) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<DatePresetKey>("yesterday_today");
  const range = DATE_PRESETS.find((p) => p.key === preset)!.range();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["facebook-tab", range.from, range.to, siteId],
    queryFn: async () => {
      const sb = supabase as any; // tabelas novas, ainda fora dos tipos gerados
      const { data: accounts } = await sb.from("fb_ad_accounts").select("id,ad_account_id,name,currency,site_id,last_sync_at,last_sync_error").eq("active", true);
      const accs = ((accounts ?? []) as FbAccount[]).filter((a) => siteId === "all" || a.site_id === siteId);
      if (!accs.length) return { accs, fbRows: [] as FbRow[], rev: [] as RevRow[], netBySite: {} as Record<string, number> };
      const { data: rows } = await sb.from("fb_ad_daily")
        .select("ad_account_id,date,campaign_id,campaign_name,ad_id,ad_name,spend,impressions,link_clicks,landing_page_views")
        .in("ad_account_id", accs.map((a) => a.ad_account_id))
        .gte("date", range.from).lte("date", range.to).limit(10000);
      const fbRows = (rows ?? []) as FbRow[];
      const siteIds = [...new Set(accs.map((a) => a.site_id).filter(Boolean))] as string[];
      const campaignIds = [...new Set(fbRows.map((r) => r.campaign_id))];
      let rev: RevRow[] = [];
      if (siteIds.length && campaignIds.length) {
        const { data: r } = await sb.from("gam_campaign_source_revenue")
          .select("site_id,campaign_id,date,revenue_usd,impressions")
          .in("site_id", siteIds).in("campaign_id", campaignIds)
          .gte("date", range.from).lte("date", range.to).limit(10000);
        rev = (r ?? []) as RevRow[];
      }
      const netBySite: Record<string, number> = {};
      for (const s of siteIds) netBySite[s] = 1 - (await getRevSharePct(s)) / 100;
      return { accs, fbRows, rev, netBySite };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const accById = new Map(data.accs.map((a) => [a.ad_account_id, a]));
    const toUsd = (v: number, accId: string) => (accById.get(accId)?.currency === "BRL" && fxUsdBrl > 0 ? v / fxUsdBrl : v);
    const total = emptyAgg();
    const camps = new Map<string, Agg & { name: string; site: string | null; ads: Map<string, Agg & { name: string }> }>();
    const days = new Map<string, Agg>();
    for (const r of data.fbRows) {
      const acc = accById.get(r.ad_account_id);
      const c = camps.get(r.campaign_id) ?? { ...emptyAgg(), name: r.campaign_name ?? r.campaign_id, site: acc?.site_id ?? null, ads: new Map() };
      const ad = c.ads.get(r.ad_id) ?? { ...emptyAgg(), name: r.ad_name ?? r.ad_id };
      const d = days.get(r.date) ?? emptyAgg();
      const spend = toUsd(Number(r.spend), r.ad_account_id);
      for (const a of [c, ad, d, total]) {
        a.spend += spend; a.impressions += Number(r.impressions); a.clicks += Number(r.link_clicks); a.lpv += Number(r.landing_page_views);
      }
      c.ads.set(r.ad_id, ad); camps.set(r.campaign_id, c); days.set(r.date, d);
    }
    for (const r of data.rev) {
      const c = camps.get(r.campaign_id);
      if (!c || (c.site && c.site !== r.site_id)) continue; // receita só do site dono da conta
      const v = Number(r.revenue_usd) * (data.netBySite[r.site_id] ?? 1);
      c.revenue += v; total.revenue += v;
      const d = days.get(r.date) ?? emptyAgg();
      d.revenue += v; days.set(r.date, d);
    }
    return {
      total,
      camps: [...camps.entries()].sort((a, b) => b[1].spend - a[1].spend),
      days: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])),
    };
  }, [data, fxUsdBrl]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { data: res, error } = await supabase.functions.invoke("meta-ads-sync", { body: { days: 7 } });
      if (error || (res as any)?.error) throw new Error((res as any)?.error ?? error?.message);
      const bad = ((res as any)?.result ?? []).filter((r: any) => r.error);
      toast({ title: bad.length ? "Facebook: erro em alguma conta" : "Facebook sincronizado", description: bad.map((b: any) => `${b.account}: ${b.error}`).join(" · ") || undefined, variant: bad.length ? "destructive" : undefined });
      await qc.invalidateQueries({ queryKey: ["facebook-tab"] });
    } catch (e) {
      toast({ title: "Falha ao sincronizar o Facebook", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  const t = view?.total ?? emptyAgg();
  const lastSync = data?.accs.map((a) => a.last_sync_at).filter(Boolean).sort().pop();
  const syncErr = data?.accs.find((a) => a.last_sync_error)?.last_sync_error;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {PRESET_KEYS.map((k) => (
          <Button key={k} size="sm" variant={preset === k ? "default" : "outline"} onClick={() => setPreset(k)}>
            {DATE_PRESETS.find((p) => p.key === k)!.label}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {lastSync ? `Gasto atualizado ${new Date(lastSync).toLocaleString("pt-BR")}` : "Gasto ainda não sincronizado"}
          </span>
          <Button size="sm" variant="outline" onClick={sync} disabled={syncing} className="gap-1.5">
            <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} /> Sincronizar
          </Button>
        </div>
      </div>
      {syncErr && <p className="text-sm text-danger">Erro na última sincronização: {syncErr}</p>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Gasto Facebook" value={fmtUSD(t.spend)} icon={Wallet} />
        <MetricCard label="Receita (líquida)" value={fmtUSD(t.revenue)} icon={DollarSign} hint="GAM pelo utm_campaign, já sem o revshare" />
        <MetricCard label="Lucro" value={fmtUSD(t.revenue - t.spend)} icon={TrendingUp} variant={t.revenue - t.spend >= 0 ? "success" : "danger"} />
        <MetricCard label="ROI" value={fmtPercent(roi(t))} icon={Percent} variant={roi(t) >= 0 ? "success" : "danger"} />
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Campanhas</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0 sm:p-6 sm:pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campanha / anúncio</TableHead>
                <TableHead className="text-right">Gasto</TableHead>
                <TableHead className="text-right">Receita</TableHead>
                <TableHead className="text-right">Lucro</TableHead>
                <TableHead className="text-right">ROI</TableHead>
                <TableHead className="text-right">Cliques</TableHead>
                <TableHead className="text-right">Visualiz. página</TableHead>
                <TableHead className="text-right">CPC</TableHead>
                <TableHead className="text-right">Receita/visualiz.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>}
              {!isLoading && !view?.camps.length && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">{siteId !== "all" && !data?.accs.length ? "Nenhuma conta da Meta ligada a este site." : "Nenhum gasto do Facebook no período. Clique em Sincronizar."}</TableCell></TableRow>
              )}
              {view?.camps.map(([cid, c]) => (
                <Fragment key={cid}>
                  <TableRow className="cursor-pointer font-medium" onClick={() => setOpen((o) => ({ ...o, [cid]: !o[cid] }))}>
                    <TableCell className="max-w-[320px]">
                      <span className="inline-flex items-center gap-1">
                        {open[cid] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        <span className="truncate">{c.name}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{fmtUSD(c.spend)}</TableCell>
                    <TableCell className="text-right">{fmtUSD(c.revenue)}</TableCell>
                    <TableCell className={cn("text-right", c.revenue - c.spend >= 0 ? "text-success" : "text-danger")}>{fmtUSD(c.revenue - c.spend)}</TableCell>
                    <TableCell className="text-right"><Badge variant={roi(c) >= 0 ? "default" : "destructive"}>{fmtPercent(roi(c))}</Badge></TableCell>
                    <TableCell className="text-right">{fmtNumber(c.clicks)}</TableCell>
                    <TableCell className="text-right">{fmtNumber(c.lpv)}</TableCell>
                    <TableCell className="text-right">{c.clicks ? fmtUSD(c.spend / c.clicks) : "—"}</TableCell>
                    <TableCell className="text-right">{c.lpv ? fmtUSD(c.revenue / c.lpv) : "—"}</TableCell>
                  </TableRow>
                  {open[cid] && [...c.ads.entries()].sort((a, b) => b[1].spend - a[1].spend).map(([aid, a]) => (
                    <TableRow key={aid} className="text-muted-foreground text-sm">
                      <TableCell className="pl-9 truncate max-w-[320px]">{a.name}</TableCell>
                      <TableCell className="text-right">{fmtUSD(a.spend)}</TableCell>
                      <TableCell className="text-right" title="Receita só por campanha">—</TableCell>
                      <TableCell className="text-right">—</TableCell>
                      <TableCell className="text-right">—</TableCell>
                      <TableCell className="text-right">{fmtNumber(a.clicks)}</TableCell>
                      <TableCell className="text-right">{fmtNumber(a.lpv)}</TableCell>
                      <TableCell className="text-right">{a.clicks ? fmtUSD(a.spend / a.clicks) : "—"}</TableCell>
                      <TableCell className="text-right">—</TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Por dia</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0 sm:p-6 sm:pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dia</TableHead>
                <TableHead className="text-right">Gasto</TableHead>
                <TableHead className="text-right">Receita</TableHead>
                <TableHead className="text-right">Lucro</TableHead>
                <TableHead className="text-right">ROI</TableHead>
                <TableHead className="text-right">Visualiz. página</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view?.days.map(([d, a]) => (
                <TableRow key={d}>
                  <TableCell>{d.split("-").reverse().join("/")}</TableCell>
                  <TableCell className="text-right">{fmtUSD(a.spend)}</TableCell>
                  <TableCell className="text-right">{fmtUSD(a.revenue)}</TableCell>
                  <TableCell className={cn("text-right", a.revenue - a.spend >= 0 ? "text-success" : "text-danger")}>{fmtUSD(a.revenue - a.spend)}</TableCell>
                  <TableCell className="text-right">{fmtPercent(roi(a))}</TableCell>
                  <TableCell className="text-right">{fmtNumber(a.lpv)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        Receita = GAM do site da conta com utm_campaign igual ao ID da campanha do Facebook, menos o revshare do site. O GAM do dia atual chega com atraso.
      </p>
    </div>
  );
}
