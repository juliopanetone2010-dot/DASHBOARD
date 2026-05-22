import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ChevronDown, ChevronUp, Sparkles, Pause, Play, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPercent, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDashboardData } from "@/hooks/useDashboardData";
import { DATE_PRESETS, type DatePresetKey } from "@/components/dashboard/FilterBar";
import { getNetFactor } from "@/lib/revshare";

interface CreativeRow {
  campaign_id: string;
  campaign_name: string | null;
  ad_group_id: string;
  ad_group_name: string | null;
  ad_id: string;
  ad_name: string | null;
  ad_type: string | null;
  ad_status: string | null;
  google_account_id: string | null;
  date: string;
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  revenue_usd: number;
}

interface Props { fxUsdBrl: number; }

type SortKey = "cost" | "revenue" | "roi" | "clicks" | "impressions";

interface AdAgg {
  campaign_id: string;
  ad_group_id: string;
  ad_group_name: string;
  ad_id: string;
  ad_name: string;
  ad_type: string;
  ad_status: string;
  cost: number;
  revenue_brl: number;
  clicks: number;
  impressions: number;
  conversions: number;
  days: number;
  roi: number;
  ctr: number;
  firstSeen: string;
  isNew: boolean;
}

interface CampAgg {
  campaign_id: string;
  campaign_name: string;
  google_account_id: string | null;
  cost: number;
  revenue_brl: number;
  clicks: number;
  impressions: number;
  conversions: number;
  roi: number;
  ads: AdAgg[];
}

const STATUS_LABELS: Record<string, string> = {
  ENABLED: "Ativo",
  PAUSED: "Pausado",
  REMOVED: "Removido",
};

export function CreativesTab({ fxUsdBrl }: Props) {
  const dash = useDashboardData();

  const [preset, setPreset] = useState<DatePresetKey>("last_7_days");
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [siteId, setSiteId] = useState<string>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "cost", dir: "desc" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set()); // key: campaign|adgroup|adid
  const [showDebug, setShowDebug] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [acting, setActing] = useState(false);
  const [rows, setRows] = useState<CreativeRow[]>([]);
  const [netFactor, setNetFactor] = useState(1);

  // Regras
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [minCost, setMinCost] = useState(200);
  const [minDays, setMinDays] = useState(7);
  const [minDiff, setMinDiff] = useState(10);

  const range = useMemo(() => {
    const p = DATE_PRESETS.find((d) => d.key === preset);
    return p ? p.range() : DATE_PRESETS[1].range();
  }, [preset]);

  const visibleAccounts = useMemo(() => {
    if (siteId === "all") return dash.googleAccounts;
    const linked = new Set(dash.links.filter((l) => l.site_id === siteId).map((l) => l.google_account_id));
    return dash.googleAccounts.filter((a) => linked.has(a.id));
  }, [dash.googleAccounts, dash.links, siteId]);

  const effectiveAccountIds = useMemo(() => {
    if (accountIds.length > 0) return accountIds;
    if (siteId === "all") return [];
    return visibleAccounts.map((a) => a.id);
  }, [accountIds, siteId, visibleAccounts]);

  // Carrega regras do usuário
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("rules_config")
        .select("creative_auto_optimize_enabled, creative_min_cost_brl, creative_min_days, creative_min_roi_diff_pct")
        .maybeSingle();
      if (data) {
        setAutoEnabled(!!data.creative_auto_optimize_enabled);
        setMinCost(Number(data.creative_min_cost_brl ?? 200));
        setMinDays(Number(data.creative_min_days ?? 7));
        setMinDiff(Number(data.creative_min_roi_diff_pct ?? 10));
      }
    })();
  }, []);

  const saveRules = async (patch: Partial<{ creative_auto_optimize_enabled: boolean; creative_min_cost_brl: number; creative_min_days: number; creative_min_roi_diff_pct: number }>) => {
    const { data: u } = await supabase.auth.getUser();
    if (!u?.user) return;
    await supabase.from("rules_config").update(patch).eq("user_id", u.user.id);
  };

  const load = async () => {
    setLoading(true);
    try {
      let q = supabase
        .from("creative_metrics")
        .select("campaign_id, campaign_name, ad_group_id, ad_group_name, ad_id, ad_name, ad_type, ad_status, google_account_id, date, cost, clicks, impressions, conversions, revenue_usd")
        .gte("date", range.from)
        .lte("date", range.to);
      if (effectiveAccountIds.length > 0) q = q.in("google_account_id", effectiveAccountIds);
      const { data, error } = await q.limit(50000);
      if (error) {
        toast({ title: "Erro ao carregar", description: error.message, variant: "destructive" });
        setRows([]); return;
      }
      let list = (data ?? []) as CreativeRow[];

      if (siteId !== "all") {
        const { data: attr } = await supabase
          .from("gam_placement_revenue")
          .select("campaign_id")
          .eq("site_id", siteId)
          .gte("date", range.from)
          .lte("date", range.to)
          .limit(50000);
        const allowed = new Set((attr ?? [])
          .map((r: { campaign_id: string | null }) => String(r.campaign_id ?? ""))
          .filter((id) => id && id !== "__aggregate__"));
        list = allowed.size > 0 ? list.filter((r) => allowed.has(String(r.campaign_id))) : [];
      }
      setRows(list);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, effectiveAccountIds.join("|"), siteId]);

  const sync = async () => {
    setSyncing(true);
    try {
      const days = Math.max(1, Math.ceil((+new Date(range.to) - +new Date(range.from)) / 86400_000) + 1);
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; rows?: number }>(
        "google-ads-sync-creatives",
        { body: { lookback_days: days, site_id: siteId === "all" ? undefined : siteId } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao sincronizar", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      toast({ title: "Sincronizado", description: `${data?.rows ?? 0} linhas importadas` });
      await load();
    } finally { setSyncing(false); }
  };

  // Agregação por campanha + criativo
  const campaigns: CampAgg[] = useMemo(() => {
    const adMap = new Map<string, AdAgg & { datesSet: Set<string> }>();
    const campMap = new Map<string, CampAgg>();
    for (const r of rows) {
      const revBrl = Number(r.revenue_usd) * fxUsdBrl;
      const adKey = `${r.campaign_id}|${r.ad_group_id}|${r.ad_id}`;
      const a = adMap.get(adKey);
      if (a) {
        a.cost += r.cost; a.revenue_brl += revBrl; a.clicks += r.clicks;
        a.impressions += r.impressions; a.conversions += r.conversions;
        a.datesSet.add(r.date);
      } else {
        adMap.set(adKey, {
          campaign_id: r.campaign_id, ad_group_id: r.ad_group_id, ad_group_name: r.ad_group_name ?? "", ad_id: r.ad_id,
          ad_name: r.ad_name ?? `Ad ${r.ad_id}`, ad_type: r.ad_type ?? "", ad_status: r.ad_status ?? "ENABLED",
          cost: r.cost, revenue_brl: revBrl, clicks: r.clicks, impressions: r.impressions,
          conversions: r.conversions, days: 0, roi: 0, ctr: 0,
          firstSeen: r.date, isNew: false,
          datesSet: new Set([r.date]),
        });
      }
      const c = campMap.get(r.campaign_id);
      if (c) {
        c.cost += r.cost; c.revenue_brl += revBrl; c.clicks += r.clicks;
        c.impressions += r.impressions; c.conversions += r.conversions;
      } else {
        campMap.set(r.campaign_id, {
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name ?? r.campaign_id,
          google_account_id: r.google_account_id,
          cost: r.cost, revenue_brl: revBrl, clicks: r.clicks,
          impressions: r.impressions, conversions: r.conversions,
          roi: 0, ads: [],
        });
      }
    }
    const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
    for (const a of adMap.values()) {
      a.days = a.datesSet.size;
      a.roi = a.cost > 0 ? ((a.revenue_brl - a.cost) / a.cost) * 100 : 0;
      a.ctr = a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0;
      a.firstSeen = [...a.datesSet].sort()[0];
      a.isNew = a.firstSeen >= threeDaysAgo;
      const camp = campMap.get(a.campaign_id);
      if (camp) camp.ads.push(a);
    }
    for (const c of campMap.values()) {
      c.roi = c.cost > 0 ? ((c.revenue_brl - c.cost) / c.cost) * 100 : 0;
      c.ads.sort((a, b) => b.cost - a.cost);
    }
    return [...campMap.values()].sort((a, b) => b.cost - a.cost);
  }, [rows, fxUsdBrl]);

  // Decisão por criativo dentro da campanha
  const decideAd = (ad: AdAgg, bestRoi: number | null) => {
    if (ad.cost < minCost) return { tag: "ok", reason: `Custo abaixo de R$ ${minCost} (proteção)` } as const;
    if (ad.days < minDays) return { tag: "ok", reason: `Apenas ${ad.days}d rodando (mín. ${minDays})` } as const;
    if (bestRoi == null) return { tag: "ok", reason: "Sem referência" } as const;
    if (ad.roi >= bestRoi - 0.0001) return { tag: "best", reason: `Melhor ROI da campanha (${ad.roi.toFixed(1)}%)` } as const;
    const diff = bestRoi - ad.roi;
    if (diff >= minDiff) return { tag: "bad", reason: `ROI ${diff.toFixed(1)}pp abaixo do melhor (${bestRoi.toFixed(1)}%)` } as const;
    return { tag: "ok", reason: `Diferença ${diff.toFixed(1)}pp < ${minDiff}pp` } as const;
  };

  const candidates = useMemo(() => {
    const out: { ad: AdAgg; bestRoi: number; reason: string }[] = [];
    for (const c of campaigns) {
      const eligible = c.ads.filter((a) => a.cost >= minCost && a.days >= minDays);
      if (eligible.length < 2) continue;
      const bestRoi = Math.max(...eligible.map((a) => a.roi));
      for (const a of c.ads) {
        const d = decideAd(a, bestRoi);
        if (d.tag === "bad" && a.ad_status === "ENABLED") {
          out.push({ ad: a, bestRoi, reason: d.reason });
        }
      }
    }
    return out;
  }, [campaigns, minCost, minDays, minDiff]);

  const toggleExpand = (k: string) => setExpanded((s) => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const toggleSelect = (k: string) => setSelected((s) => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const toggleAccount = (id: string) => setAccountIds((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  const accountLabel = accountIds.length === 0
    ? (siteId === "all" ? "Todas as contas" : `Todas do site (${visibleAccounts.length})`)
    : accountIds.length === 1 ? (visibleAccounts.find((a) => a.id === accountIds[0])?.descriptive_name ?? "1 conta")
    : `${accountIds.length} contas`;

  const pauseAds = async (ads: AdAgg[]) => {
    if (ads.length === 0) {
      toast({ title: "Nenhum criativo selecionado", variant: "destructive" });
      return;
    }
    setActing(true);
    try {
      // Agrupa por campanha (a edge function exige campaign_id por chamada)
      const byCamp = new Map<string, AdAgg[]>();
      for (const a of ads) {
        const list = byCamp.get(a.campaign_id) ?? [];
        list.push(a);
        byCamp.set(a.campaign_id, list);
      }
      let okCount = 0;
      for (const [cid, list] of byCamp) {
        const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
          "google-ads-mutate",
          { body: {
              action: "set_ad_status",
              campaign_id: cid,
              status: "PAUSED",
              ads: list.map((a) => ({ ad_group_id: a.ad_group_id, ad_id: a.ad_id })),
            } },
        );
        if (error || data?.error) {
          toast({ title: `Erro na campanha ${cid}`, description: data?.error ?? error?.message, variant: "destructive" });
        } else {
          okCount += list.length;
        }
      }
      if (okCount > 0) {
        toast({ title: "Criativos pausados", description: `${okCount} criativo(s) desativado(s)` });
        setSelected(new Set());
        await load();
      }
    } finally { setActing(false); }
  };

  const resumeAd = async (ad: AdAgg) => {
    setActing(true);
    try {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
        "google-ads-mutate",
        { body: {
            action: "set_ad_status",
            campaign_id: ad.campaign_id,
            status: "ENABLED",
            ads: [{ ad_group_id: ad.ad_group_id, ad_id: ad.ad_id }],
          } },
      );
      if (error || data?.error) {
        toast({ title: "Erro ao ativar", description: data?.error ?? error?.message, variant: "destructive" });
      } else {
        toast({ title: "Criativo ativado" });
        await load();
      }
    } finally { setActing(false); }
  };

  const visibleCampaigns = useMemo(() => {
    if (!onlyNew) return campaigns;
    return campaigns
      .map((c) => ({ ...c, ads: c.ads.filter((a) => a.isNew) }))
      .filter((c) => c.ads.length > 0);
  }, [campaigns, onlyNew]);

  const newAdsCount = useMemo(
    () => campaigns.reduce((acc, c) => acc + c.ads.filter((a) => a.isNew).length, 0),
    [campaigns],
  );

  const totalCost = visibleCampaigns.reduce((a, c) => a + (onlyNew ? c.ads.reduce((x, y) => x + y.cost, 0) : c.cost), 0);
  const totalRev = visibleCampaigns.reduce((a, c) => a + (onlyNew ? c.ads.reduce((x, y) => x + y.revenue_brl, 0) : c.revenue_brl), 0);
  const totalRoi = totalCost > 0 ? ((totalRev - totalCost) / totalCost) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Controles */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={preset} onValueChange={(v) => setPreset(v as DatePresetKey)}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {DATE_PRESETS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={siteId} onValueChange={(v) => { setSiteId(v); setAccountIds([]); }}>
          <SelectTrigger className="w-[180px]"><SelectValue placeholder="Site" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os sites</SelectItem>
            {dash.sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">{accountLabel}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64">
            {visibleAccounts.map((a) => (
              <DropdownMenuCheckboxItem
                key={a.id}
                checked={accountIds.includes(a.id)}
                onCheckedChange={() => toggleAccount(a.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {a.descriptive_name ?? a.customer_id}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={accountIds.length === 0}
              onCheckedChange={() => setAccountIds([])}
              onSelect={(e) => e.preventDefault()}
            >
              Todas
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Atualizar
        </Button>
        <Button variant="outline" size="sm" onClick={sync} disabled={syncing} className="gap-2">
          {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sincronizar Google Ads
        </Button>

        <Button variant="ghost" size="sm" onClick={() => setShowDebug((s) => !s)} className="gap-1.5">
          <Bug className="h-3.5 w-3.5" /> Debug
        </Button>

        <Button
          variant={onlyNew ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyNew((v) => !v)}
          className="gap-1.5"
        >
          <Sparkles className="h-3.5 w-3.5" /> Novos (3d)
          <Badge variant="secondary" className="ml-1">{newAdsCount}</Badge>
        </Button>

        <div className="ml-auto flex items-center gap-3">
          <div className="text-xs text-muted-foreground">
            Custo: <span className="font-medium text-foreground">{fmtBRL(totalCost)}</span> ·
            Receita: <span className="font-medium text-foreground"> {fmtBRL(totalRev)}</span> ·
            ROI: <span className={cn("font-medium", totalRoi >= 0 ? "text-success" : "text-danger")}>{fmtPercent(totalRoi)}</span>
          </div>
        </div>
      </div>

      {/* Regras */}
      <div className="flex flex-wrap items-center gap-4 p-3 rounded-md border bg-muted/30">
        <div className="flex items-center gap-2">
          <Switch
            id="auto-creative"
            checked={autoEnabled}
            onCheckedChange={(v) => { setAutoEnabled(v); saveRules({ creative_auto_optimize_enabled: v }); }}
          />
          <Label htmlFor="auto-creative" className="text-sm">Otimização automática</Label>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <Label className="text-xs text-muted-foreground">Custo mín. (R$)</Label>
          <input
            type="number" value={minCost} className="w-20 h-8 px-2 rounded border bg-background text-sm"
            onChange={(e) => setMinCost(Number(e.target.value) || 0)}
            onBlur={() => saveRules({ creative_min_cost_brl: minCost })}
          />
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <Label className="text-xs text-muted-foreground">Dias mín.</Label>
          <input
            type="number" value={minDays} className="w-16 h-8 px-2 rounded border bg-background text-sm"
            onChange={(e) => setMinDays(Number(e.target.value) || 0)}
            onBlur={() => saveRules({ creative_min_days: minDays })}
          />
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <Label className="text-xs text-muted-foreground">Dif. ROI mín. (pp)</Label>
          <input
            type="number" value={minDiff} className="w-16 h-8 px-2 rounded border bg-background text-sm"
            onChange={(e) => setMinDiff(Number(e.target.value) || 0)}
            onBlur={() => saveRules({ creative_min_roi_diff_pct: minDiff })}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Badge variant="secondary">{candidates.length} candidato(s) a desativação</Badge>
          <Button
            size="sm" variant="default" disabled={acting || candidates.length === 0}
            onClick={() => pauseAds(candidates.map((c) => c.ad))}
            className="gap-1.5"
          >
            <Sparkles className="h-3.5 w-3.5" /> Aplicar sugestões
          </Button>
          <Button
            size="sm" variant="destructive" disabled={acting || selected.size === 0}
            onClick={() => {
              const all: AdAgg[] = [];
              for (const c of campaigns) for (const a of c.ads)
                if (selected.has(`${a.campaign_id}|${a.ad_group_id}|${a.ad_id}`)) all.push(a);
              pauseAds(all);
            }}
            className="gap-1.5"
          >
            <Pause className="h-3.5 w-3.5" /> Desativar selecionados ({selected.size})
          </Button>
        </div>
      </div>

      {/* Tabela */}
      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Campanha / Criativo</TableHead>
              <TableHead className="text-right">Impr.</TableHead>
              <TableHead className="text-right">Cliques</TableHead>
              <TableHead className="text-right">CTR</TableHead>
              <TableHead className="text-right">Custo</TableHead>
              <TableHead className="text-right">Receita</TableHead>
              <TableHead className="text-right">Lucro</TableHead>
              <TableHead className="text-right">ROI</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="w-[140px]">Ação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={11} className="text-center py-10"><Loader2 className="h-4 w-4 animate-spin inline" /></TableCell></TableRow>
            ) : visibleCampaigns.length === 0 ? (
              <TableRow><TableCell colSpan={11} className="text-center py-10 text-muted-foreground text-sm">
                {onlyNew ? "Nenhum criativo novo nos últimos 3 dias." : <>Nenhum criativo encontrado. Clique em <strong>Sincronizar Google Ads</strong>.</>}
              </TableCell></TableRow>
            ) : visibleCampaigns.map((c) => {
              const isOpen = expanded.has(c.campaign_id);
              const eligible = c.ads.filter((a) => a.cost >= minCost && a.days >= minDays);
              const bestRoi = eligible.length > 0 ? Math.max(...eligible.map((a) => a.roi)) : null;
              return (
                <Fragment key={c.campaign_id}>
                  <TableRow className="bg-muted/40 cursor-pointer" onClick={() => toggleExpand(c.campaign_id)}>
                    <TableCell>
                      {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </TableCell>
                    <TableCell className="font-medium">
                      {c.campaign_name}
                      <span className="ml-2 text-xs text-muted-foreground">({c.ads.length} criativos)</span>
                    </TableCell>
                    <TableCell className="text-right">{fmtNumber(c.impressions)}</TableCell>
                    <TableCell className="text-right">{fmtNumber(c.clicks)}</TableCell>
                    <TableCell className="text-right">{fmtPercent(c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0)}</TableCell>
                    <TableCell className="text-right">{fmtBRL(c.cost)}</TableCell>
                    <TableCell className="text-right">{fmtBRL(c.revenue_brl)}</TableCell>
                    <TableCell className={cn("text-right", c.revenue_brl - c.cost >= 0 ? "text-success" : "text-danger")}>
                      {fmtBRL(c.revenue_brl - c.cost)}
                    </TableCell>
                    <TableCell className={cn("text-right font-medium", c.roi >= 0 ? "text-success" : "text-danger")}>
                      {fmtPercent(c.roi)}
                    </TableCell>
                    <TableCell />
                    <TableCell />
                  </TableRow>
                  {isOpen && c.ads.map((a) => {
                    const k = `${a.campaign_id}|${a.ad_group_id}|${a.ad_id}`;
                    const decision = decideAd(a, bestRoi);
                    const profit = a.revenue_brl - a.cost;
                    return (
                      <TableRow key={k} className={cn(a.ad_status !== "ENABLED" && "opacity-60")}>
                        <TableCell>
                          <Checkbox
                            checked={selected.has(k)}
                            onCheckedChange={() => toggleSelect(k)}
                            disabled={a.ad_status !== "ENABLED"}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {decision.tag === "best" && <Badge className="bg-success text-success-foreground">🟢 Melhor</Badge>}
                            {decision.tag === "ok" && <Badge variant="secondary">🟡 Ok</Badge>}
                            {decision.tag === "bad" && <Badge variant="destructive">🔴 Ruim</Badge>}
                            {a.isNew && <Badge className="bg-primary text-primary-foreground">✨ Novo</Badge>}
                            <span className="text-sm">{a.ad_name}</span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {a.ad_group_name} · {a.ad_type} · {a.days}d · desde {a.firstSeen}
                            {showDebug && bestRoi != null && (
                              <span className="ml-2 italic">[best ROI: {bestRoi.toFixed(1)}% · {decision.reason}]</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{fmtNumber(a.impressions)}</TableCell>
                        <TableCell className="text-right">{fmtNumber(a.clicks)}</TableCell>
                        <TableCell className="text-right">{fmtPercent(a.ctr)}</TableCell>
                        <TableCell className="text-right">{fmtBRL(a.cost)}</TableCell>
                        <TableCell className="text-right">{fmtBRL(a.revenue_brl)}</TableCell>
                        <TableCell className={cn("text-right", profit >= 0 ? "text-success" : "text-danger")}>
                          {fmtBRL(profit)}
                        </TableCell>
                        <TableCell className={cn("text-right font-medium", a.roi >= 0 ? "text-success" : "text-danger")}>
                          {fmtPercent(a.roi)}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant={a.ad_status === "ENABLED" ? "outline" : "secondary"} className="text-xs">
                            {STATUS_LABELS[a.ad_status] ?? a.ad_status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {a.ad_status === "ENABLED" ? (
                            <Button size="sm" variant="ghost" disabled={acting}
                              onClick={() => pauseAds([a])} className="gap-1 h-7">
                              <Pause className="h-3 w-3" /> Pausar
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" disabled={acting}
                              onClick={() => resumeAd(a)} className="gap-1 h-7">
                              <Play className="h-3 w-3" /> Ativar
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {showDebug && candidates.length > 0 && (
        <div className="rounded-md border p-3 text-xs space-y-1 bg-muted/30">
          <div className="font-medium mb-1">Candidatos a desativação</div>
          {candidates.map((c) => (
            <div key={`${c.ad.campaign_id}|${c.ad.ad_id}`}>
              <span className="text-danger">●</span> {c.ad.ad_name}: ROI {c.ad.roi.toFixed(1)}% (melhor: {c.bestRoi.toFixed(1)}%) — {c.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
