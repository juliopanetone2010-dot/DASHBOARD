import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Ban, Loader2, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtNumber, fmtPercent, fmtUSD, fmtBRL } from "@/lib/format";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { REV_SHARE_PCT } from "@/engine/rules";
import { DATE_PRESETS, type DatePresetKey } from "@/components/dashboard/FilterBar";
import { useDashboardFilters } from "@/contexts/FilterContext";
import type { Campaign, GoogleAccount } from "@/types/domain";

interface AdsPlacementRow {
  id: string;
  placement: string;
  placement_clean: string | null;
  display_name: string | null;
  target_url: string | null;
  placement_type: string | null;
  ad_group_name: string | null;
  campaign_name: string | null;
  campaign_id: string;
  date: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  ctr: number;
  avg_cpc: number;
}

interface GamRevRow { placement: string; revenue_usd: number; impressions: number; date: string; utm_source?: string | null; raw_utm?: string | null; }
interface CampaignMetricRow { revenue: number; clicks: number; impressions: number; date: string; }
interface ApplyUtmResult { error?: string; success?: number; total?: number; failed?: number; }
interface PlacementActionRow { placement: string; action: "blacklist" | "favorite"; }

interface AggRow {
  placement: string;          // full normalizado (ex: may.karwin.com)
  placementRoot: string;      // root domain (ex: karwin.com)
  type: string;
  ad_groups: Set<string>;
  impressions: number;
  clicks: number;
  costBrl: number;            // Custo NATIVO da conta Ads (BRL)
  conversions: number;
  revenueUsd: number;         // GAM USD bruto
  revenueUsdNet: number;      // GAM USD após rev share
  revenueBrl: number;         // revenueUsdNet * fxUsdBrl
  profitBrl: number;          // receita_brl - custo_brl
  roi: number;                // ROI calculado em BRL
  revenueSource: "utm_full" | "utm_root" | "utm_prefix" | "none";
  matchedUtm: string | null;  // qual utm_placement bateu
  ctr: number;
  cpcBrl: number;
}

type SortKey = "roi" | "costBrl" | "conversions" | "ctr" | "impressions";

interface Props {
  campaigns: Campaign[];
  googleAccounts: GoogleAccount[];
  fxUsdBrl?: number;               // câmbio aproximado (vem da última sync)
}

const PAGE_SIZE = 100;
const QUERY_PAGE_SIZE = 1000;

const formatIsoDateBR = (iso: string) => {
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${day}/${month}/${year}` : iso;
};

const normalizePlacementKey = (value: string, type?: string | null): string => {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "";
  const mobileApp = raw.match(/mobileapp::\d+-(.+)$/i);
  if (mobileApp) return mobileApp[1].replace(/^www\./, "");
  if (type === "MOBILE_APPLICATION") {
    const numericApp = raw.match(/^\d+-(.+)$/);
    if (numericApp) return numericApp[1].replace(/^www\./, "");
  }
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^www\./, "");
  }
};

const isMobileAppPlacement = (type: string, placement: string) =>
  type === "MOBILE_APPLICATION" || /^[a-z0-9_]+(\.[a-z0-9_-]+){1,}$/i.test(placement);

const findPrefixRevenueKey = (placement: string, keys: string[], usedKeys: Set<string>) => {
  const normalized = placement.replace(/\.$/, "");
  return keys
    .filter((key) => {
      if (usedKeys.has(key)) return false;
      const prefix = key.replace(/\.$/, "");
      return prefix.length >= 8 && normalized.startsWith(prefix);
    })
    .sort((a, b) => b.length - a.length)[0] ?? null;
};

async function fetchAllAdsPlacements(cid: string, from: string, to: string) {
  const all: AdsPlacementRow[] = [];
  for (let start = 0; ; start += QUERY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("ads_placements")
      .select("*")
      .eq("campaign_id", cid)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: false })
      .order("placement", { ascending: true })
      .range(start, start + QUERY_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as AdsPlacementRow[];
    all.push(...page);
    if (page.length < QUERY_PAGE_SIZE) break;
  }
  return all;
}

async function fetchAllGamPlacementRevenue(cid: string, from: string, to: string) {
  const all: GamRevRow[] = [];
  for (let start = 0; ; start += QUERY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("gam_placement_revenue")
      .select("placement, revenue_usd, impressions, date, utm_source, raw_utm")
      .eq("campaign_id", cid)
      .eq("utm_source", "google")
      .gte("date", from)
      .lte("date", to)
      .range(start, start + QUERY_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as GamRevRow[];
    all.push(...page);
    if (page.length < QUERY_PAGE_SIZE) break;
  }
  return all;
}

export function PlacementsTab({ campaigns, googleAccounts, fxUsdBrl = 4.97 }: Props) {
  const { range, version, presetKey, filters: globalFilters, setFilters: setGlobalFilters } = useDashboardFilters();
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [campaignId, setCampaignId] = useState<string>("");
  const [lastAutoSelectedAccount, setLastAutoSelectedAccount] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Local preset is just a label for display; the actual range comes from the global filter.
  const [preset, setPreset] = useState<DatePresetKey>(presetKey ?? "last_7_days");
  const [rows, setRows] = useState<AdsPlacementRow[]>([]);
  const [gamRows, setGamRows] = useState<GamRevRow[]>([]);
  const [campaignMetricRows, setCampaignMetricRows] = useState<CampaignMetricRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("roi");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [actions, setActions] = useState<Record<string, "blacklist" | "favorite" | undefined>>({});
  const [showDebug, setShowDebug] = useState(false);
  const [applyingUtm, setApplyingUtm] = useState(false);

  // Sincroniza com o filtro global de contas
  useEffect(() => {
    setAccountIds(globalFilters.googleAccountIds);
  }, [globalFilters.googleAccountIds]);

  // Mantém o preset visual em sincronia com o filtro global
  useEffect(() => {
    if (presetKey) setPreset(presetKey);
  }, [presetKey]);

  const applyUtmAll = async () => {
    if (!confirm("Aplicar UTM padrão (utm_placement={campaignid}_{placement}) no Final URL Suffix de TODAS as campanhas?\n\nIsso é necessário para que o GAM consiga associar receita por placement.")) return;
    setApplyingUtm(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-ads-apply-utm-bulk", {
        body: accountIds.length ? { account_ids: accountIds } : {},
      });
      if (error) {
        toast({ title: "Erro ao aplicar UTM", description: error.message, variant: "destructive" });
        return;
      }
      const r = data as ApplyUtmResult | null;
      if (r?.error) {
        toast({ title: "Erro", description: r.error, variant: "destructive" });
        return;
      }
      toast({
        title: "UTM aplicado",
        description: `${r?.success ?? 0}/${r?.total ?? 0} campanhas atualizadas${r?.failed ? ` (${r.failed} falha(s))` : ""}.`,
      });
    } finally {
      setApplyingUtm(false);
    }
  };


  const visibleCampaigns = useMemo(() => {
    return campaigns
      .filter((c) => accountIds.length === 0 || (c.google_account_id && accountIds.includes(c.google_account_id)))
      .filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.campaign_id.includes(search));
  }, [campaigns, accountIds, search]);

  useEffect(() => {
    if (!campaignId) return;
    const selected = campaigns.find((c) => c.campaign_id === campaignId);
    if (!selected?.google_account_id || accountIds.includes(selected.google_account_id)) return;
    if (accountIds.length === 0 || lastAutoSelectedAccount === selected.google_account_id) return;
    setCampaignId("");
  }, [accountIds, campaignId, campaigns, lastAutoSelectedAccount]);

  const selectCampaign = (cid: string) => {
    const selected = campaigns.find((c) => c.campaign_id === cid);
    if (selected?.google_account_id) {
      setAccountIds([selected.google_account_id]);
      setLastAutoSelectedAccount(selected.google_account_id);
    }
    setCampaignId(cid);
  };

  const fetchPlacements = async (cid: string) => {
    setLoading(true);
    setRows([]);
    setGamRows([]);
    setCampaignMetricRows([]);
    try {
      const from = range.from;
      const to = range.to;
      if (import.meta.env.DEV) {
        console.info("[placements] fetch", { campaign: cid, from, to, accounts: accountIds, version });
      }
      const { error } = await supabase.functions.invoke("google-ads-sync-placements", {
        body: { campaign_id: cid, from, to },
      });
      if (error) {
        toast({ title: "Erro ao sincronizar", description: error.message, variant: "destructive" });
        return;
      }
      // Mantém a receita GAM atualizada no mesmo período antes de recalcular lucro/ROI.
      await supabase.functions.invoke("gam-sync-revenue", {
        body: { from, to, account_ids: accountIds },
      });
      const adsData = await fetchAllAdsPlacements(cid, from, to);
      setRows(adsData);
      setLimit(PAGE_SIZE);

      // Receita do GAM atribuída via UTM Google (campaign_id + placement).
      const gamData = await fetchAllGamPlacementRevenue(cid, from, to);
      setGamRows(gamData);

      // Fallback: quando ainda não existe UTM por placement, usa a receita da campanha
      // já atribuída pelo GAM e distribui pelos placements por cliques/impressões.
      const { data: metricData } = await supabase
        .from("daily_metrics")
        .select("revenue, clicks, impressions, date")
        .eq("campaign_id", cid)
        .gte("date", from)
        .lte("date", to);
      setCampaignMetricRows((metricData ?? []) as CampaignMetricRow[]);

      // Carrega ações (blacklist/favorite) para os placements desta campanha
      const { data: acts } = await supabase
        .from("placement_actions")
        .select("placement, action")
        .eq("campaign_id", cid);
      const map: Record<string, "blacklist" | "favorite"> = {};
      for (const a of (acts ?? []) as PlacementActionRow[]) map[a.placement] = a.action;
      setActions(map);
    } catch (e) {
      toast({ title: "Erro ao carregar placements", description: String(e instanceof Error ? e.message : e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (campaignId) void fetchPlacements(campaignId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, range.from, range.to, version]);

  // Extrai root domain (karwin.com de may.karwin.com). Apps/youtube ficam iguais.
  const rootDomain = (host: string): string => {
    if (!host) return host;
    if (host.includes("/") || !host.includes(".")) return host; // app id ou outro formato
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    // pega últimos 2 (ignora suffixes compostos como .com.br)
    const last2 = parts.slice(-2).join(".");
    const ccTLDs = new Set(["com.br", "co.uk", "com.au", "com.mx", "co.jp", "com.ar", "co.in"]);
    if (ccTLDs.has(last2) && parts.length >= 3) return parts.slice(-3).join(".");
    return last2;
  };

  // Receita GAM por placement (já agrupada via UTM no backend)
  const gamRevenueByPlacement = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of gamRows) {
      const key = normalizePlacementKey(g.placement || "");
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + Number(g.revenue_usd ?? 0));
    }
    return map;
  }, [gamRows]);

  const aggregated: AggRow[] = useMemo(() => {
    const map = new Map<string, AggRow>();
    const revenueKeys = [...gamRevenueByPlacement.keys()];
    const usedPrefixRevenueKeys = new Set<string>();
    for (const r of rows) {
      const rawPlacement = normalizePlacementKey(r.placement_clean || r.placement, r.placement_type);
      // Mantém o subdomínio como chave (ex: may.karwin.com separado de karwin.com).
      // O root domain é guardado para fallback de match de receita via UTM.
      const key = rawPlacement;
      const root = rootDomain(rawPlacement);
      let agg = map.get(key);
      if (!agg) {
        agg = {
          placement: key,
          placementRoot: root,
          type: r.placement_type ?? "—",
          ad_groups: new Set(),
          impressions: 0, clicks: 0, costBrl: 0, conversions: 0,
          revenueUsd: 0, revenueUsdNet: 0, revenueBrl: 0, profitBrl: 0, roi: 0,
          revenueSource: "none", matchedUtm: null, ctr: 0, cpcBrl: 0,
        };
        map.set(key, agg);
      }
      if (r.ad_group_name) agg.ad_groups.add(r.ad_group_name);
      agg.impressions += Number(r.impressions);
      agg.clicks += Number(r.clicks);
      agg.costBrl += Number(r.cost); // custo NATIVO (BRL na conta BR)
      agg.conversions += Number(r.conversions);
    }
    const values = [...map.values()];
    for (const a of values) {
      // Match: 1) full normalizado  2) root domain
      let usd = gamRevenueByPlacement.get(a.placement) ?? 0;
      let source: AggRow["revenueSource"] = "none";
      let matchedKey: string | null = null;
      if (usd > 0) { source = "utm_full"; matchedKey = a.placement; }
      else if (a.placementRoot && a.placementRoot !== a.placement) {
        const rootUsd = gamRevenueByPlacement.get(a.placementRoot) ?? 0;
        if (rootUsd > 0) { usd = rootUsd; source = "utm_root"; matchedKey = a.placementRoot; }
      }
      if (usd <= 0 && isMobileAppPlacement(a.type, a.placement)) {
        const prefixKey = findPrefixRevenueKey(a.placement, revenueKeys, usedPrefixRevenueKeys);
        if (prefixKey) {
          usd = gamRevenueByPlacement.get(prefixKey) ?? 0;
          if (usd > 0) { source = "utm_prefix"; matchedKey = prefixKey; usedPrefixRevenueKeys.add(prefixKey); }
        }
      }
      const usdNet = usd * (1 - REV_SHARE_PCT);
      const revenueBrl = usdNet * (fxUsdBrl > 0 ? fxUsdBrl : 1);
      a.revenueUsd = usd;
      a.revenueUsdNet = usdNet;
      a.revenueBrl = revenueBrl;
      a.profitBrl = revenueBrl - a.costBrl;
      a.roi = a.costBrl > 0 ? (a.profitBrl / a.costBrl) * 100 : 0;
      a.revenueSource = source;
      a.matchedUtm = matchedKey;
      a.ctr = a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0;
      a.cpcBrl = a.clicks > 0 ? a.costBrl / a.clicks : 0;
    }
    return values;
  }, [rows, gamRevenueByPlacement, fxUsdBrl]);

  const sorted = useMemo(() => {
    const arr = [...aggregated];
    arr.sort((a, b) => {
      const va = (a[sortKey] as number) ?? 0;
      const vb = (b[sortKey] as number) ?? 0;
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return arr;
  }, [aggregated, sortKey, sortDir]);

  const visible = sorted.slice(0, limit);
  const hasGamRevenue = gamRevenueByPlacement.size > 0;
  const matchedCount = useMemo(
    () => aggregated.filter((a) => a.revenueSource !== "none").length,
    [aggregated],
  );

  const top = useMemo(
    () => [...aggregated].filter((a) => a.costBrl > 0).sort((a, b) => b.roi - a.roi).slice(0, 5),
    [aggregated],
  );
  const worst = useMemo(
    () => [...aggregated].filter((a) => a.costBrl > 0).sort((a, b) => a.roi - b.roi).slice(0, 5),
    [aggregated],
  );

  const toggleAction = async (placement: string, action: "blacklist" | "favorite") => {
    const current = actions[placement];
    if (current === action) {
      // remove
      await supabase.from("placement_actions").delete().eq("campaign_id", campaignId).eq("placement", placement).eq("action", action);
      setActions((s) => ({ ...s, [placement]: undefined }));
      return;
    }
    const userRes = await supabase.auth.getUser();
    const uid = userRes.data.user?.id;
    if (!uid) return;
    await supabase.from("placement_actions").insert({ user_id: uid, campaign_id: campaignId, placement, action });
    setActions((s) => ({ ...s, [placement]: action }));
    toast({ title: action === "blacklist" ? "Blacklist registrada" : "Favoritado", description: placement });
  };

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "roi" ? "asc" : "desc"); }
  };

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Conta Ads</label>
            <Select
              value={accountIds.length === 1 ? accountIds[0] : "all"}
              onValueChange={(v) => {
                setLastAutoSelectedAccount(null);
                setAccountIds(v === "all" ? [] : [v]);
              }}
            >
              <SelectTrigger className="h-9"><SelectValue placeholder="Todas" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as contas</SelectItem>
                {googleAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.descriptive_name ?? a.account_name ?? a.customer_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Período (global)</label>
            <Select
              value={preset}
              onValueChange={(v) => {
                const key = v as DatePresetKey;
                setPreset(key);
                const r = DATE_PRESETS.find((p) => p.key === key)!.range();
                setGlobalFilters({ ...globalFilters, fromDate: r.from, toDate: r.to });
              }}
            >
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DATE_PRESETS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">De</label>
            <Input
              type="date"
              value={range.from}
              onChange={(e) => setGlobalFilters({ ...globalFilters, fromDate: e.target.value, toDate: range.to })}
              className="h-9"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Até</label>
            <Input
              type="date"
              value={range.to}
              onChange={(e) => setGlobalFilters({ ...globalFilters, fromDate: range.from, toDate: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground">Buscar campanha</label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome ou ID da campanha..."
              className="h-9"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-muted-foreground">Campanha (obrigatório)</label>
          <div className="flex gap-2">
            <Select value={campaignId} onValueChange={selectCampaign}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Selecione uma campanha" /></SelectTrigger>
              <SelectContent className="max-h-[400px]">
                {visibleCampaigns.length === 0 && (
                  <div className="px-2 py-3 text-sm text-muted-foreground">Nenhuma campanha encontrada.</div>
                )}
                {visibleCampaigns.map((c) => (
                  <SelectItem key={c.campaign_id} value={c.campaign_id}>
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{c.campaign_id}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline" size="sm"
              disabled={!campaignId || loading}
              onClick={() => campaignId && fetchPlacements(campaignId)}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Aplicar UTM em todas as campanhas */}
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[260px]">
          <div className="text-sm font-semibold">UTMs nas campanhas</div>
          <div className="text-xs text-muted-foreground">
            Aplica <code className="bg-muted px-1 rounded">{"utm_placement={campaignid}_{placement}"}</code> no Final URL Suffix de todas as campanhas {accountIds.length ? "da conta filtrada" : "de todas as contas"}. Necessário para casar receita do GAM por placement.
          </div>
        </div>
        <Button onClick={applyUtmAll} disabled={applyingUtm} variant="default">
          {applyingUtm ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Aplicar UTM {accountIds.length ? "(conta filtrada)" : "em todas"}
        </Button>
      </div>

      {!campaignId && (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-10 text-center text-sm text-muted-foreground">
          Selecione uma campanha para carregar os placements.
        </div>
      )}

      {campaignId && (
        <>
          {/* Top / piores */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RankingCard title="🏆 Top placements (ROI)" rows={top} variant="best" hasRevenue={hasGamRevenue} />
            <RankingCard title="💀 Piores placements" rows={worst} variant="worst" hasRevenue={hasGamRevenue} />
          </div>

          {/* Aviso GAM + debug */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              Período Ads: {formatIsoDateBR(range.from)}–{formatIsoDateBR(range.to)}
            </Badge>
            {hasGamRevenue ? (
              <Badge variant="outline" className="text-xs">
                Receita atribuída: {matchedCount}/{aggregated.length} placement(s) · custo BRL (Ads) / receita USD→BRL (GAM)
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">
                Sem receita atribuída — sincronize o GAM ou aplique UTM nas campanhas.
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={() => setShowDebug((v) => !v)} className="ml-auto h-7">
              {showDebug ? "Ocultar debug" : "Mostrar debug"}
            </Button>
          </div>
          {showDebug && (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs font-mono space-y-1">
              <div>ads rows: <b>{rows.length}</b> · placements únicos: <b>{aggregated.length}</b></div>
              <div>gam rows (UTM): <b>{gamRows.length}</b> · placements GAM únicos: <b>{gamRevenueByPlacement.size}</b></div>
              <div>match: full=<b>{aggregated.filter(a => a.revenueSource === "utm_full").length}</b> · root=<b>{aggregated.filter(a => a.revenueSource === "utm_root").length}</b> · sem receita=<b>{aggregated.length - matchedCount}</b> · mobile com receita=<b>{aggregated.filter(a => isMobileAppPlacement(a.type, a.placement) && a.revenueSource !== "none").length}</b></div>
              <div>custo: vem do Google Ads em <b>BRL nativo</b> (sem conversão) · rev share: <b>{(REV_SHARE_PCT * 100).toFixed(1)}%</b></div>
              <div>receita: GAM em USD → convertida p/ BRL via fx <b>{fxUsdBrl}</b> · ROI calculado em BRL</div>
            </div>
          )}

          {/* Tabela */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold">{aggregated.length} placement(s)</h3>
              <div className="text-xs text-muted-foreground">
                Ordenar:{" "}
                <button onClick={() => toggleSort("roi")} className={cn("ml-1 hover:underline", sortKey === "roi" && "text-primary font-medium")}>ROI</button> ·{" "}
                <button onClick={() => toggleSort("costBrl")} className={cn("hover:underline", sortKey === "costBrl" && "text-primary font-medium")}>Custo</button> ·{" "}
                <button onClick={() => toggleSort("conversions")} className={cn("hover:underline", sortKey === "conversions" && "text-primary font-medium")}>Conv.</button> ·{" "}
                <button onClick={() => toggleSort("ctr")} className={cn("hover:underline", sortKey === "ctr" && "text-primary font-medium")}>CTR</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Placement</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("impressions")}>Impr.</TableHead>
                    <TableHead className="text-right">Cliques</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("ctr")}>CTR</TableHead>
                    <TableHead className="text-right">CPC (BRL)</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("conversions")}>Conv.</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("costBrl")}>Custo Ads (BRL)</TableHead>
                    <TableHead className="text-right">Receita GAM</TableHead>
                    <TableHead className="text-right">Lucro (BRL)</TableHead>
                    <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("roi")}>ROI</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                    {showDebug && <TableHead className="text-xs">Debug</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.length === 0 && !loading && (
                    <TableRow><TableCell colSpan={showDebug ? 13 : 12} className="text-center py-8 text-muted-foreground">Sem placements no período.</TableCell></TableRow>
                  )}
                  {loading && (
                    <TableRow><TableCell colSpan={showDebug ? 13 : 12} className="text-center py-8 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Sincronizando...
                    </TableCell></TableRow>
                  )}
                  {visible.map((r) => {
                    const matched = r.revenueSource !== "none";
                    const negative = matched && r.roi < 0;
                    const lowCtr = r.impressions > 1000 && r.ctr < 0.3;
                    const wasted = r.costBrl > 100 && r.conversions === 0;
                    const action = actions[r.placement];
                    return (
                      <TableRow key={r.placement} className={cn(action === "blacklist" && "opacity-50")}>
                        <TableCell className="font-mono text-xs max-w-[260px] truncate" title={r.placement}>
                          {r.placement}
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {r.revenueSource === "utm_full" && <Badge variant="outline" className="text-[9px]">UTM full</Badge>}
                            {r.revenueSource === "utm_root" && <Badge variant="outline" className="text-[9px]">UTM root</Badge>}
                            {r.revenueSource === "utm_prefix" && <Badge variant="outline" className="text-[9px]">UTM app</Badge>}
                            {r.revenueSource === "none" && <Badge variant="outline" className="text-[9px]">sem receita</Badge>}
                            {negative && <Badge variant="destructive" className="text-[9px]">ROI&lt;0</Badge>}
                            {lowCtr && <Badge variant="secondary" className="text-[9px] bg-warning/20 text-warning">CTR baixo</Badge>}
                            {wasted && <Badge variant="secondary" className="text-[9px] bg-warning/20 text-warning">Sem conv.</Badge>}
                            {action === "favorite" && <Badge className="text-[9px] bg-primary/20 text-primary">★ favorito</Badge>}
                            {action === "blacklist" && <Badge variant="destructive" className="text-[9px]">blacklist</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.type}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNumber(r.impressions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNumber(r.clicks)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.ctr.toFixed(2)}%</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtBRL(r.cpcBrl)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.conversions.toFixed(1)}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{fmtBRL(r.costBrl)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {matched ? (
                            <div>
                              <div>{fmtUSD(r.revenueUsdNet)}</div>
                              <div className="text-[10px] text-muted-foreground/70">≈ {fmtBRL(r.revenueBrl)}</div>
                            </div>
                          ) : "—"}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums font-medium", matched ? (r.profitBrl >= 0 ? "text-success" : "text-danger") : "text-muted-foreground")}>
                          {matched ? fmtBRL(r.profitBrl) : "—"}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums font-semibold", matched ? (r.roi >= 0 ? "text-success" : "text-danger") : "text-muted-foreground")}>
                          {matched ? fmtPercent(r.roi) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Favoritar" onClick={() => toggleAction(r.placement, "favorite")}>
                              <Star className={cn("h-3.5 w-3.5", action === "favorite" && "fill-primary text-primary")} />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-danger" title="Excluir (blacklist)" onClick={() => toggleAction(r.placement, "blacklist")}>
                              <Ban className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                        {showDebug && (
                          <TableCell className="text-[10px] font-mono whitespace-nowrap">
                            <div>cid: <b>{campaignId}</b></div>
                            <div>full: {r.placement}</div>
                            <div>root: {r.placementRoot}</div>
                            <div>cost_ads: R$ {r.costBrl.toFixed(2)} (BRL)</div>
                            <div>utm_match: {r.matchedUtm ?? "—"} ({r.revenueSource})</div>
                            <div>rev_usd: ${r.revenueUsd.toFixed(4)} → net ${r.revenueUsdNet.toFixed(4)}</div>
                            <div>fx: {fxUsdBrl} → rev_brl: R$ {r.revenueBrl.toFixed(2)}</div>
                            <div>roi: {r.roi.toFixed(2)}%</div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {sorted.length > limit && (
              <div className="p-3 border-t border-border flex justify-center">
                <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                  Carregar mais ({sorted.length - limit} restantes)
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RankingCard({ title, rows, variant, hasRevenue }: { title: string; rows: AggRow[]; variant: "best" | "worst"; hasRevenue: boolean }) {
  const Icon = variant === "best" ? ArrowUp : ArrowDown;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      {rows.length === 0 && <div className="text-xs text-muted-foreground py-4">Sem dados.</div>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.placement} className="flex items-center justify-between text-sm">
            <span className="truncate max-w-[60%] font-mono text-xs" title={r.placement}>{r.placement}</span>
            <span className={cn(
              "tabular-nums text-xs flex items-center gap-1",
              hasRevenue ? (r.roi >= 0 ? "text-success" : "text-danger") : "text-muted-foreground",
            )}>
              <Icon className="h-3 w-3" />
              {hasRevenue ? `${r.roi.toFixed(1)}%` : `${fmtBRL(r.costBrl)} gasto`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
