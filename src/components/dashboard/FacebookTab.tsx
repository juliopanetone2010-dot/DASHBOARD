// Aba Facebook: gasto da Meta (fb_ad_daily, via meta-ads-sync) × receita do GAM (gam_campaign_source_revenue,
// campaign_id = ID da campanha do Facebook vindo do utm_campaign) → lucro e ROI por campanha e por dia.
// Tudo em USD: a Meta cobra em USD (C1) e o GAM grava revenue_usd. Conta em BRL é convertida com fxUsdBrl.
// Com um site escolhido no topo, só entram as contas da Meta ligadas a ele (fb_ad_accounts.site_id) e a receita do GAM desse site.
// Dias = quantos dias a campanha já teve gasto (todo o histórico, não só o período). O botão liga/pausa a campanha na Meta
// (função meta-campaign-status; conta com token só de leitura devolve erro).
// A receita só existe por campanha (o gam-sync não lê utm_content), então os anúncios mostram só gasto/cliques.
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Wallet, TrendingUp, DollarSign, Percent, ChevronDown, ChevronRight, History, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { fmtUSD, fmtNumber, fmtPercent } from "@/lib/format";
import { getRevSharePct } from "@/lib/revshare";
import { DATE_PRESETS, type DatePresetKey } from "@/components/dashboard/FilterBar";
import { MetricCard } from "./MetricCard";
import { toast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

interface FbAccount { id: string; ad_account_id: string; name: string | null; currency: string; site_id: string | null; last_sync_at: string | null; last_sync_error: string | null }
interface FbRow { ad_account_id: string; date: string; campaign_id: string; campaign_name: string | null; ad_id: string; ad_name: string | null; spend: number; impressions: number; link_clicks: number; landing_page_views: number; results: number; result_name: string | null }
interface RevRow { site_id: string; campaign_id: string; date: string; revenue_usd: number; impressions: number; ecpm_url_usd: number | null }

interface Agg { spend: number; impressions: number; clicks: number; lpv: number; revenue: number; conv: number }
// Ordenação da tabela de campanhas (11/10): clique no título da coluna; 2º clique inverte. Sem valor (—) vai sempre pro fim.
type OrdKey = "orc" | "dias" | "spend" | "revenue" | "lucro" | "roi" | "conv" | "cpa" | "ecpm" | "clicks" | "lpv" | "cpc" | "rpv";
const emptyAgg = (): Agg => ({ spend: 0, impressions: 0, clicks: 0, lpv: 0, revenue: 0, conv: 0 });
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
      if (!accs.length) return { accs, fbRows: [] as FbRow[], rev: [] as RevRow[], netBySite: {} as Record<string, number>, diasGasto: {} as Record<string, number> };
      const { data: rows } = await sb.from("fb_ad_daily")
        .select("ad_account_id,date,campaign_id,campaign_name,ad_id,ad_name,spend,impressions,link_clicks,landing_page_views,results,result_name")
        .in("ad_account_id", accs.map((a) => a.ad_account_id))
        .gte("date", range.from).lte("date", range.to).limit(10000);
      const fbRows = (rows ?? []) as FbRow[];
      const siteIds = [...new Set(accs.map((a) => a.site_id).filter(Boolean))] as string[];
      const campaignIds = [...new Set(fbRows.map((r) => r.campaign_id))];
      let rev: RevRow[] = [];
      if (siteIds.length && campaignIds.length) {
        const { data: r } = await sb.from("gam_campaign_source_revenue")
          .select("site_id,campaign_id,date,revenue_usd,impressions,ecpm_url_usd")
          .in("site_id", siteIds).in("campaign_id", campaignIds)
          .gte("date", range.from).lte("date", range.to).limit(10000);
        rev = (r ?? []) as RevRow[];
      }
      // Dias com gasto desde o início de cada campanha (fora do filtro de período).
      const diasGasto: Record<string, number> = {};
      if (campaignIds.length) {
        const { data: h } = await sb.from("fb_ad_daily").select("campaign_id,date,spend").in("campaign_id", campaignIds).gt("spend", 0).limit(20000);
        const set = new Map<string, Set<string>>();
        for (const r of (h ?? []) as any[]) { const k = String(r.campaign_id); if (!set.has(k)) set.set(k, new Set()); set.get(k)!.add(r.date); }
        for (const [k, v] of set) diasGasto[k] = v.size;
      }
      const netBySite: Record<string, number> = {};
      for (const s of siteIds) netBySite[s] = 1 - (await getRevSharePct(s)) / 100;
      return { accs, fbRows, rev, netBySite, diasGasto };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const accById = new Map(data.accs.map((a) => [a.ad_account_id, a]));
    const toUsd = (v: number, accId: string) => (accById.get(accId)?.currency === "BRL" && fxUsdBrl > 0 ? v / fxUsdBrl : v);
    const total = emptyAgg();
    const camps = new Map<string, Agg & { name: string; site: string | null; resultName: string | null; ecpmUrl: number[]; ads: Map<string, Agg & { name: string }> }>();
    const days = new Map<string, Agg>();
    for (const r of data.fbRows) {
      const acc = accById.get(r.ad_account_id);
      const c = camps.get(r.campaign_id) ?? { ...emptyAgg(), name: r.campaign_name ?? r.campaign_id, site: acc?.site_id ?? null, resultName: null, ecpmUrl: [], ads: new Map() };
      if (r.result_name && Number(r.spend) > 0) c.resultName = r.result_name;
      const ad = c.ads.get(r.ad_id) ?? { ...emptyAgg(), name: r.ad_name ?? r.ad_id };
      const d = days.get(r.date) ?? emptyAgg();
      const spend = toUsd(Number(r.spend), r.ad_account_id);
      for (const a of [c, ad, d, total]) {
        a.spend += spend; a.impressions += Number(r.impressions); a.clicks += Number(r.link_clicks); a.lpv += Number(r.landing_page_views); a.conv += Number(r.results || 0);
      }
      c.ads.set(r.ad_id, ad); camps.set(r.campaign_id, c); days.set(r.date, d);
    }
    for (const r of data.rev) {
      const c = camps.get(r.campaign_id);
      if (!c || (c.site && c.site !== r.site_id)) continue; // receita só do site dono da conta
      const v = Number(r.revenue_usd) * (data.netBySite[r.site_id] ?? 1);
      c.revenue += v; total.revenue += v;
      if (r.ecpm_url_usd != null && Number(r.ecpm_url_usd) > 0) c.ecpmUrl.push(Number(r.ecpm_url_usd));
      const d = days.get(r.date) ?? emptyAgg();
      d.revenue += v; days.set(r.date, d);
    }
    return {
      total,
      camps: [...camps.entries()].sort((a, b) => b[1].spend - a[1].spend),
      days: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])),
    };
  }, [data, fxUsdBrl]);

  const campIds = view?.camps.map(([cid]) => cid) ?? [];
  const { data: status } = useQuery({
    queryKey: ["facebook-status", campIds.join(",")],
    enabled: campIds.length > 0,
    queryFn: async () => {
      const { data: res } = await supabase.functions.invoke("meta-campaign-status", { body: { campaigns: campIds } });
      return { ...((res as any)?.status ?? {}), __budget: (res as any)?.budget ?? {} } as Record<string, any>;
    },
  });
  const [mudando, setMudando] = useState<string | null>(null);
  const [hist, setHist] = useState<{ cid: string; name: string; site: string | null } | null>(null);
  const alternar = async (cid: string, ligar: boolean) => {
    setMudando(cid);
    try {
      const { data: res, error } = await supabase.functions.invoke("meta-campaign-status", { body: { campaign_id: cid, status: ligar ? "ACTIVE" : "PAUSED" } });
      if (error || (res as any)?.error) throw new Error((res as any)?.error ?? error?.message);
      toast({ title: ligar ? "Campanha ativada" : "Campanha pausada" });
      await qc.invalidateQueries({ queryKey: ["facebook-status"] });
    } catch (e) {
      toast({ title: "Não deu para mudar a campanha", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setMudando(null);
    }
  };

  const mudarOrcamento = async (cid: string, atual?: number) => {
    const v = window.prompt("Novo orçamento diário (na moeda da conta, ex.: 3 ou 5.50):", atual ? String(atual) : "");
    if (v === null) return;
    const val = Number(v.replace(",", "."));
    if (!(val >= 1)) { toast({ title: "Valor inválido", variant: "destructive" }); return; }
    setMudando(cid);
    try {
      const { data: res, error } = await supabase.functions.invoke("meta-campaign-status", { body: { campaign_id: cid, daily_budget: val } });
      if (error || (res as any)?.error) throw new Error((res as any)?.error ?? error?.message);
      toast({ title: `Orçamento: ${val.toFixed(2)}/dia` });
      await qc.invalidateQueries({ queryKey: ["facebook-status"] });
    } catch (e) {
      toast({ title: "Não deu para mudar o orçamento", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setMudando(null);
    }
  };

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
  const [ord, setOrd] = useState<{ k: OrdKey; asc: boolean }>({ k: "spend", asc: false });
  const ecpmMedio = (c: { ecpmUrl: number[] }) => (c.ecpmUrl.length ? c.ecpmUrl.reduce((a, b) => a + b, 0) / c.ecpmUrl.length : null);
  const valorOrd = (cid: string, c: Agg & { ecpmUrl: number[] }, k: OrdKey): number | null => {
    switch (k) {
      case "orc": return status?.__budget?.[cid] ?? null;
      case "dias": return data?.diasGasto?.[cid] ?? 0;
      case "spend": return c.spend;
      case "revenue": return c.revenue;
      case "lucro": return c.revenue - c.spend;
      case "roi": return c.spend > 0 ? roi(c) : null;
      case "conv": return c.conv;
      case "cpa": return c.conv ? c.spend / c.conv : null;
      case "ecpm": return ecpmMedio(c);
      case "clicks": return c.clicks;
      case "lpv": return c.lpv;
      case "cpc": return c.clicks ? c.spend / c.clicks : null;
      case "rpv": return c.lpv ? c.revenue / c.lpv : null;
    }
  };
  const campsOrd = [...(view?.camps ?? [])].sort(([ia, a], [ib, b]) => {
    const va = valorOrd(ia, a, ord.k), vb = valorOrd(ib, b, ord.k);
    if (va == null && vb == null) return b.spend - a.spend;
    if (va == null) return 1;
    if (vb == null) return -1;
    return ord.asc ? va - vb : vb - va;
  });
  const Th = ({ k, children, title }: { k: OrdKey; children: ReactNode; title?: string }) => (
    <TableHead className="text-right cursor-pointer select-none whitespace-nowrap hover:text-foreground" title={title ?? "Clique para ordenar"}
      onClick={() => setOrd((o) => (o.k === k ? { k, asc: !o.asc } : { k, asc: false }))}>
      <span className="inline-flex items-center gap-1">{children}
        {ord.k === k ? (ord.asc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
      </span>
    </TableHead>
  );
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
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[200px]">Campanha / anúncio</TableHead>
                <TableHead className="text-center">Ativa</TableHead>
                <Th k="orc">Orçam./dia</Th>
                <Th k="dias">Dias</Th>
                <Th k="spend">Gasto</Th>
                <Th k="revenue">Receita</Th>
                <Th k="lucro">Lucro</Th>
                <Th k="roi">ROI</Th>
                <Th k="conv">Conversões</Th>
                <Th k="cpa">Custo/conv.</Th>
                <Th k="ecpm" title="eCPM da página de destino no GAM (todo o tráfego da URL), média dos dias do período">eCPM URL</Th>
                <Th k="clicks">Cliques</Th>
                <Th k="lpv">Visualiz. página</Th>
                <Th k="cpc">CPC</Th>
                <Th k="rpv">Receita/visualiz.</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={15} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>}
              {!isLoading && !view?.camps.length && (
                <TableRow><TableCell colSpan={15} className="text-center text-muted-foreground">{siteId !== "all" && !data?.accs.length ? "Nenhuma conta da Meta ligada a este site." : "Nenhum gasto do Facebook no período. Clique em Sincronizar."}</TableCell></TableRow>
              )}
              {campsOrd.map(([cid, c]) => (
                <Fragment key={cid}>
                  <TableRow className="cursor-pointer font-medium" onClick={() => setOpen((o) => ({ ...o, [cid]: !o[cid] }))}>
                    <TableCell className="min-w-[200px] max-w-[260px] whitespace-normal break-words align-top">
                      <span className="flex items-start gap-1">
                        {open[cid] ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />}
                        <span className="text-xs leading-snug sm:text-sm">{c.name}
                          {c.resultName && <span className="block text-[11px] font-normal text-muted-foreground">conversão: {c.resultName}</span>}
                        </span>
                        <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" title="Histórico"
                          onClick={(e) => { e.stopPropagation(); setHist({ cid, name: c.name, site: c.site }); }}>
                          <History className="h-4 w-4" />
                        </Button>
                      </span>
                    </TableCell>
                    <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                      {status?.[cid] ? (
                        <Switch checked={status[cid] === "ACTIVE"} disabled={mudando === cid} onCheckedChange={(v) => alternar(cid, v)}
                          title={status[cid]} />
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="outline" className="h-7 px-2" disabled={mudando === cid}
                        onClick={() => mudarOrcamento(cid, status?.__budget?.[cid])}>
                        {status?.__budget?.[cid] != null ? fmtUSD(status.__budget[cid]) : "—"}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">{data?.diasGasto?.[cid] ?? 0}</TableCell>
                    <TableCell className="text-right">{fmtUSD(c.spend)}</TableCell>
                    <TableCell className="text-right">{fmtUSD(c.revenue)}</TableCell>
                    <TableCell className={cn("text-right", c.revenue - c.spend >= 0 ? "text-success" : "text-danger")}>{fmtUSD(c.revenue - c.spend)}</TableCell>
                    <TableCell className="text-right"><Badge variant={roi(c) >= 0 ? "default" : "destructive"}>{fmtPercent(roi(c))}</Badge></TableCell>
                    <TableCell className="text-right" title={c.resultName ?? undefined}>{fmtNumber(c.conv)}</TableCell>
                    <TableCell className="text-right">{c.conv ? fmtUSD(c.spend / c.conv) : "—"}</TableCell>
                    <TableCell className="text-right">{c.ecpmUrl.length ? fmtUSD(c.ecpmUrl.reduce((a, b) => a + b, 0) / c.ecpmUrl.length) : "—"}</TableCell>
                    <TableCell className="text-right">{fmtNumber(c.clicks)}</TableCell>
                    <TableCell className="text-right">{fmtNumber(c.lpv)}</TableCell>
                    <TableCell className="text-right">{c.clicks ? fmtUSD(c.spend / c.clicks) : "—"}</TableCell>
                    <TableCell className="text-right">{c.lpv ? fmtUSD(c.revenue / c.lpv) : "—"}</TableCell>
                  </TableRow>
                  {open[cid] && [...c.ads.entries()].sort((a, b) => b[1].spend - a[1].spend).map(([aid, a]) => (
                    <TableRow key={aid} className="text-muted-foreground text-sm">
                      <TableCell className="pl-9 max-w-[260px] whitespace-normal break-words text-xs">{a.name}</TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell />
                      <TableCell className="text-right">{fmtUSD(a.spend)}</TableCell>
                      <TableCell className="text-right" title="Receita só por campanha">—</TableCell>
                      <TableCell className="text-right">—</TableCell>
                      <TableCell className="text-right">—</TableCell>
                      <TableCell className="text-right">{fmtNumber(a.conv)}</TableCell>
                      <TableCell className="text-right">{a.conv ? fmtUSD(a.spend / a.conv) : "—"}</TableCell>
                      <TableCell />
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
      <FbHistorico alvo={hist} onClose={() => setHist(null)} net={hist?.site ? (data?.netBySite[hist.site] ?? 1) : 1} />
      <p className="text-xs text-muted-foreground">
        Receita = GAM do site da conta com utm_campaign igual ao ID da campanha do Facebook, menos o revshare do site. O GAM do dia atual chega com atraso.
      </p>
    </div>
  );
}

// Histórico dia a dia da campanha desde o primeiro gasto: gasto, receita líquida do GAM, lucro, ROI, conversões e visitas.
function FbHistorico({ alvo, onClose, net }: { alvo: { cid: string; name: string; site: string | null } | null; onClose: () => void; net: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["facebook-hist", alvo?.cid],
    enabled: !!alvo,
    queryFn: async () => {
      const sb = supabase as any;
      const { data: rows } = await sb.from("fb_ad_daily").select("date,spend,results,landing_page_views").eq("campaign_id", alvo!.cid).limit(5000);
      let q = sb.from("gam_campaign_source_revenue").select("date,revenue_usd,ecpm_url_usd").eq("campaign_id", alvo!.cid);
      if (alvo!.site) q = q.eq("site_id", alvo!.site);
      const { data: rev } = await q.limit(5000);
      const dias = new Map<string, { spend: number; rev: number; conv: number; lpv: number; ecpm?: number }>();
      const pega = (d: string) => dias.get(d) ?? { spend: 0, rev: 0, conv: 0, lpv: 0 };
      for (const r of (rows ?? []) as any[]) {
        const d = pega(r.date);
        d.spend += Number(r.spend); d.conv += Number(r.results || 0); d.lpv += Number(r.landing_page_views); dias.set(r.date, d);
      }
      for (const r of (rev ?? []) as any[]) {
        const d = pega(r.date);
        d.rev += Number(r.revenue_usd) * net; if (r.ecpm_url_usd != null) d.ecpm = Number(r.ecpm_url_usd); dias.set(r.date, d);
      }
      return [...dias.entries()].filter(([, d]) => d.spend > 0 || d.rev > 0).sort((a, b) => b[0].localeCompare(a[0]));
    },
  });
  const tot = (data ?? []).reduce((a, [, d]) => ({ spend: a.spend + d.spend, rev: a.rev + d.rev, conv: a.conv + d.conv }), { spend: 0, rev: 0, conv: 0 });
  return (
    <Dialog open={!!alvo} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="text-sm leading-snug">{alvo?.name}</DialogTitle></DialogHeader>
        {isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> : (
          <div className="overflow-x-auto">
            <p className="mb-2 text-sm">
              Total: gasto {fmtUSD(tot.spend)} · receita {fmtUSD(tot.rev)} · lucro {fmtUSD(tot.rev - tot.spend)} · ROI {fmtPercent(tot.spend ? ((tot.rev - tot.spend) / tot.spend) * 100 : 0)} · {fmtNumber(tot.conv)} conversões
            </p>
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Dia</TableHead>
                  <TableHead className="text-right">Gasto</TableHead>
                  <TableHead className="text-right">Receita</TableHead>
                  <TableHead className="text-right">Lucro</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Conv.</TableHead>
                  <TableHead className="text-right">Custo/conv.</TableHead>
                  <TableHead className="text-right">Visitas</TableHead>
                  <TableHead className="text-right">eCPM URL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map(([d, x]) => (
                  <TableRow key={d}>
                    <TableCell>{d.split("-").reverse().join("/")}</TableCell>
                    <TableCell className="text-right">{fmtUSD(x.spend)}</TableCell>
                    <TableCell className="text-right">{fmtUSD(x.rev)}</TableCell>
                    <TableCell className={cn("text-right", x.rev - x.spend >= 0 ? "text-success" : "text-danger")}>{fmtUSD(x.rev - x.spend)}</TableCell>
                    <TableCell className="text-right">{fmtPercent(x.spend ? ((x.rev - x.spend) / x.spend) * 100 : 0)}</TableCell>
                    <TableCell className="text-right">{fmtNumber(x.conv)}</TableCell>
                    <TableCell className="text-right">{x.conv ? fmtUSD(x.spend / x.conv) : "—"}</TableCell>
                    <TableCell className="text-right">{fmtNumber(x.lpv)}</TableCell>
                    <TableCell className="text-right">{x.ecpm ? fmtUSD(x.ecpm) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
