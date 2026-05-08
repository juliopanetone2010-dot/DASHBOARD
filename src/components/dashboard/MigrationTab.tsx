import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownAZ, RefreshCw, ArrowRightLeft, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { fmtCurrency, fmtPercent } from "@/lib/format";

type SortKey = "roi" | "spend" | "profit" | "stability";

interface EligibleItem {
  campaign_id: string;
  name: string;
  channel_type: string;
  google_account_id: string;
  google_ads_status: string;
  spend: number;
  revenue: number;
  profit: number;
  roi_pct: number;
  conversions: number;
  days_active: number;
  stability_score: number;
  top_countries: { code: string; name: string; cost: number }[];
  already_migrated: boolean;
}

export function MigrationTab() {
  const qc = useQueryClient();
  const [sourceAccountId, setSourceAccountId] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortKey>("roi");
  const [picked, setPicked] = useState<EligibleItem | null>(null);

  const accountsQ = useQuery({
    queryKey: ["mig-accounts"],
    queryFn: async () => {
      const { data } = await supabase
        .from("google_accounts")
        .select("id, account_name, descriptive_name, customer_id, status");
      return data ?? [];
    },
  });

  const sitesQ = useQuery({
    queryKey: ["mig-sites"],
    queryFn: async () => {
      const { data } = await supabase
        .from("sites").select("id, name, domain, status").eq("status", "active");
      return data ?? [];
    },
  });

  const eligibleQ = useQuery({
    queryKey: ["mig-eligible", sourceAccountId],
    queryFn: async () => {
      const params = new URLSearchParams({ days: "15" });
      if (sourceAccountId !== "all") params.set("google_account_id", sourceAccountId);
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/migration-list-eligible?${params}`;
      const sess = (await supabase.auth.getSession()).data.session;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${sess?.access_token}` } });
      return (await r.json()) as { items: EligibleItem[] };
    },
  });

  const historyQ = useQuery({
    queryKey: ["mig-history"],
    queryFn: async () => {
      const { data } = await supabase
        .from("campaign_migrations")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  const pendingQ = useQuery({
    queryKey: ["mig-pending"],
    queryFn: async () => {
      const { data } = await supabase
        .from("migration_pending_ads")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      return data ?? [];
    },
    refetchInterval: 30000,
  });

  const items = (eligibleQ.data?.items ?? []).slice().sort((a, b) => {
    if (sortBy === "roi") return b.roi_pct - a.roi_pct;
    if (sortBy === "spend") return b.spend - a.spend;
    if (sortBy === "profit") return b.profit - a.profit;
    return b.stability_score - a.stability_score;
  });

  return (
    <div className="space-y-4">
      <Tabs defaultValue="eligible">
        <TabsList>
          <TabsTrigger value="eligible">Elegíveis</TabsTrigger>
          <TabsTrigger value="pending">
            Pendentes HTML5{pendingQ.data && pendingQ.data.length > 0 ? ` (${pendingQ.data.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="eligible" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ArrowRightLeft className="h-5 w-5" />
                  Recuperação de campanhas (15 dias)
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  Campanhas DISPLAY da conta selecionada. Escolha qual migrar e defina manualmente a URL nova.
                </p>
              </div>
              <div className="flex gap-2 items-center">
                <Select value={sourceAccountId} onValueChange={setSourceAccountId}>
                  <SelectTrigger className="w-[260px]">
                    <SelectValue placeholder="Conta origem" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas as contas</SelectItem>
                    {(accountsQ.data ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.descriptive_name || a.account_name || a.customer_id}
                        {a.status !== "connected" ? ` (${a.status})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
                  <SelectTrigger className="w-[160px]">
                    <ArrowDownAZ className="h-4 w-4 mr-1" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="roi">ROI</SelectItem>
                    <SelectItem value="spend">Spend</SelectItem>
                    <SelectItem value="profit">Lucro</SelectItem>
                    <SelectItem value="stability">Estabilidade</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="icon" onClick={() => eligibleQ.refetch()}>
                  <RefreshCw className={`h-4 w-4 ${eligibleQ.isFetching ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {eligibleQ.isLoading ? (
                <p className="text-muted-foreground text-sm">Carregando…</p>
              ) : items.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nenhuma campanha DISPLAY encontrada nos últimos 15 dias.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campanha</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Lucro</TableHead>
                      <TableHead className="text-right">ROI</TableHead>
                      <TableHead className="text-right">Conv.</TableHead>
                      <TableHead className="text-right">Dias</TableHead>
                      <TableHead className="text-right">Estab.</TableHead>
                      <TableHead>Top países</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((it) => (
                      <TableRow key={it.campaign_id}>
                        <TableCell className="max-w-[260px]">
                          <div className="font-medium truncate">{it.name}</div>
                          <div className="text-xs text-muted-foreground flex gap-1.5 items-center">
                            <span>{it.campaign_id}</span>
                            {it.already_migrated && <Badge variant="secondary" className="text-[10px]">já migrada</Badge>}
                            {it.google_ads_status !== "enabled" && (
                              <Badge variant="outline" className="text-[10px]">{it.google_ads_status}</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{fmtCurrency(it.spend)}</TableCell>
                        <TableCell className={`text-right ${it.profit >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {fmtCurrency(it.profit)}
                        </TableCell>
                        <TableCell className={`text-right font-medium ${it.roi_pct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {fmtPercent(it.roi_pct)}
                        </TableCell>
                        <TableCell className="text-right">{it.conversions.toFixed(0)}</TableCell>
                        <TableCell className="text-right">{it.days_active}</TableCell>
                        <TableCell className="text-right">{it.stability_score.toFixed(0)}</TableCell>
                        <TableCell className="text-xs">
                          {it.top_countries.slice(0, 3).map((c) => c.code).join(", ") || "—"}
                        </TableCell>
                        <TableCell>
                          <Button size="sm" onClick={() => setPicked(it)}>Migrar</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Histórico de migrações</CardTitle>
            </CardHeader>
            <CardContent>
              {(historyQ.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma migração registrada ainda.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Quando</TableHead>
                      <TableHead>Campanha origem</TableHead>
                      <TableHead>Destino</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Final URL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(historyQ.data ?? []).map((m: any) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs">{new Date(m.created_at).toLocaleString("pt-BR")}</TableCell>
                        <TableCell>
                          <div className="font-medium">{m.source_campaign_name}</div>
                          <div className="text-xs text-muted-foreground">{m.source_campaign_id}</div>
                        </TableCell>
                        <TableCell>
                          <div>{m.destination_domain || "—"}</div>
                          {m.destination_campaign_id && (
                            <div className="text-xs text-muted-foreground">novo: {m.destination_campaign_id}</div>
                          )}
                        </TableCell>
                        <TableCell className="min-w-[220px]">
                          <Badge
                            variant={m.status === "success" ? "default" : m.status === "failed" ? "destructive" : "secondary"}
                          >
                            {m.status}
                          </Badge>
                          <MigrationStepSummary result={m.result} />
                          {m.error && (
                            <div className="text-xs text-rose-600 max-w-[260px] truncate" title={m.error}>{m.error}</div>
                          )}
                          <MigrationFailurePreview result={m.result} />
                        </TableCell>
                        <TableCell className="text-xs max-w-[280px] truncate" title={m.final_url}>{m.final_url}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <MigrationDrawer
        item={picked}
        accounts={accountsQ.data ?? []}
        sites={sitesQ.data ?? []}
        onClose={() => setPicked(null)}
        onSuccess={() => {
          setPicked(null);
          qc.invalidateQueries({ queryKey: ["mig-history"] });
          qc.invalidateQueries({ queryKey: ["mig-eligible"] });
        }}
      />
    </div>
  );
}

function MigrationStepSummary({ result }: { result: any }) {
  const steps = result?.debug?.steps;
  if (!steps) return null;
  const crossAccount = result?.debug?.cross_account !== false;
  const rows = [
    ["Campanha", steps.campaign_created],
    ["Ad groups", steps.ad_groups_created],
    ["Assets", !crossAccount || steps.assets_reuploaded || (Number(result?.assets_reuploaded) > 0)],
    ["Ads", steps.ads_created || (Number(result?.ads_cloned) > 0)],
  ] as const;
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, ok]) => (
        <div key={label} className={ok ? "flex items-center gap-1 text-emerald-600" : "flex items-center gap-1 text-rose-600"}>
          {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {label}
        </div>
      ))}
    </div>
  );
}

function MigrationFailurePreview({ result }: { result: any }) {
  const failures = result?.debug?.partial_failures;
  if (!Array.isArray(failures) || failures.length === 0) return null;
  const lines = failures.flatMap((f: any) => {
    const errors = Array.isArray(f.errors) ? f.errors : [f];
    return errors.map((e: any) => `${f.step || e.step || "erro"}: ${e.message || e.field_path || JSON.stringify(e).slice(0, 120)}`);
  }).slice(0, 3);
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {lines.map((line, i) => <div key={i} className="max-w-[320px] truncate" title={line}>{line}</div>)}
    </div>
  );
}

interface DrawerProps {
  item: EligibleItem | null;
  accounts: any[];
  sites: any[];
  onClose: () => void;
  onSuccess: () => void;
}

function MigrationDrawer({ item, accounts, sites, onClose, onSuccess }: DrawerProps) {
  const [destSiteId, setDestSiteId] = useState("");
  const [destAccountId, setDestAccountId] = useState("");
  const [finalUrl, setFinalUrl] = useState("");
  const [trackingTemplate, setTrackingTemplate] = useState("");
  const [finalUrlSuffix, setFinalUrlSuffix] = useState("");
  const [nameSuffix, setNameSuffix] = useState("[MIG]");
  const [initialBudget, setInitialBudget] = useState("30");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (item && !destAccountId && accounts.length > 0) {
      const firstDifferent = accounts.find((a) => a.id !== item.google_account_id && a.status === "connected");
      if (firstDifferent) setDestAccountId(firstDifferent.id);
    }
  }, [item, accounts, destAccountId]);

  async function submit() {
    if (!item) return;
    if (!destSiteId || !destAccountId || !finalUrl) {
      toast({ title: "Campos obrigatórios", description: "Site destino, conta destino e Final URL." });
      return;
    }
    try { new URL(finalUrl); }
    catch { toast({ title: "URL inválida", description: "Use uma URL completa (https://…)" }); return; }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("migration-execute", {
        body: {
          source_campaign_id: item.campaign_id,
          source_google_account_id: item.google_account_id,
          destination_site_id: destSiteId,
          destination_google_account_id: destAccountId,
          final_url: finalUrl,
          tracking_template: trackingTemplate || undefined,
          final_url_suffix: finalUrlSuffix || undefined,
          name_suffix: nameSuffix || "[MIG]",
          initial_budget: Number(initialBudget) || 30,
        },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.partial) {
        toast({
          title: "Migração parcial criada",
          description: `Campanha ${(data as any).new_campaign_id || "nova"} e ad groups mantidos. ${(data as any).error || "Revise os detalhes no histórico."}`,
        });
        onSuccess();
        return;
      }
      if (!(data as any)?.ok) throw new Error((data as any)?.error || "Falha desconhecida");
      toast({
        title: "Migrada com sucesso",
        description: `Nova campanha ${(data as any).new_campaign_id} criada PAUSED no Funil.`,
      });
      onSuccess();
    } catch (e) {
      toast({
        title: "Falha na migração",
        description: String((e as Error).message || e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={!!item} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Migrar campanha</SheetTitle>
          <SheetDescription>
            {item?.name} · ROI {item ? fmtPercent(item.roi_pct) : "—"} · spend {item ? fmtCurrency(item.spend) : "—"}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Site destino *</Label>
              <Select value={destSiteId} onValueChange={setDestSiteId}>
                <SelectTrigger><SelectValue placeholder="Selecione…" /></SelectTrigger>
                <SelectContent>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name} · {s.domain}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Conta Google Ads destino *</Label>
              <Select value={destAccountId} onValueChange={setDestAccountId}>
                <SelectTrigger><SelectValue placeholder="Selecione…" /></SelectTrigger>
                <SelectContent>
                  {accounts.filter((a) => a.status === "connected").map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.descriptive_name || a.account_name || a.customer_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Final URL nova *</Label>
            <Input
              placeholder="https://novosite.com.br/pagina"
              value={finalUrl}
              onChange={(e) => setFinalUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A Final URL é definida MANUALMENTE — nunca copiada do anúncio antigo.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Tracking template (opcional)</Label>
              <Input
                placeholder="{lpurl}?utm_source=google"
                value={trackingTemplate}
                onChange={(e) => setTrackingTemplate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Final URL suffix (opcional)</Label>
              <Input
                placeholder="utm_source=google&utm_campaign={campaignid}"
                value={finalUrlSuffix}
                onChange={(e) => setFinalUrlSuffix(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Sufixo do nome</Label>
              <Input value={nameSuffix} onChange={(e) => setNameSuffix(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Orçamento inicial (R$/dia)</Label>
              <Input
                type="number" min="1" step="1"
                value={initialBudget}
                onChange={(e) => setInitialBudget(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs space-y-1.5">
            <div className="flex items-center gap-1.5 font-medium text-amber-900 dark:text-amber-100">
              <AlertCircle className="h-3.5 w-3.5" /> O que vai acontecer
            </div>
            <ul className="list-disc pl-5 space-y-0.5 text-amber-900/90 dark:text-amber-100/80">
              <li>Cria nova campanha <strong>PAUSADA</strong> na conta destino</li>
              <li>Copia: ad groups, criativos, headlines, descriptions, geo, idioma, dispositivos, placements, keywords</li>
              <li>Substitui a Final URL pela nova ↑</li>
              <li>Para conta diferente da origem: imagens são <strong>re-uploadadas</strong>; audiences/listas são puladas</li>
              <li>Entra no <strong>Funil Inteligente</strong> (status learning) — não na automação principal</li>
            </ul>
          </div>
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Migrando…" : "Migrar agora"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
