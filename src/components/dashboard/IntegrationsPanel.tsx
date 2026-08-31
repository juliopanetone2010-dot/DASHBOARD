import { useEffect, useMemo, useState } from "react";
import {
  Plug, RefreshCw, CheckCircle2, XCircle, KeyRound, Link2, Building2, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { SitesPanel } from "./SitesPanel";
import { AccountSiteMappingPanel } from "./AccountSiteMappingPanel";
import type { AccountSiteLink, GamAccount, GoogleAccount, Site } from "@/types/domain";

interface ApiSetStatus {
  api_set: number;
  client_id: boolean;
  client_secret: boolean;
  developer_token: boolean;
  configured: boolean;
}
interface OAuthStatus {
  configured: boolean;
  api_sets?: ApiSetStatus[];
  configured_api_sets?: number[];
  default_api_set?: number;
}

interface IntegrationsPanelProps {
  googleAccounts?: GoogleAccount[];
  gamAccounts?: GamAccount[];
  sites?: Site[];
  links?: AccountSiteLink[];
  isGuest?: boolean;
  onAddGoogleAccount?: (input: Partial<GoogleAccount>) => Promise<unknown>;
  onArchiveGoogleAccount?: (id: string) => Promise<unknown>;
  onRemoveGoogleAccount?: (id: string) => Promise<unknown>;
  onAddGamAccount?: (input: Partial<GamAccount>) => Promise<unknown>;
  onRemoveGamAccount?: (id: string) => Promise<unknown>;
  onAddSite?: (input: Partial<Site>) => Promise<unknown>;
  onRemoveSite?: (id: string) => Promise<unknown>;
  onAddLink?: (googleAccountId: string, siteId: string) => Promise<unknown>;
  onRemoveLink?: (id: string) => Promise<unknown>;
  onRefresh?: () => Promise<unknown>;
}

function formatCid(cid: string) {
  const d = String(cid ?? "").replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : cid;
}

export const IntegrationsPanel = ({
  googleAccounts = [],
  gamAccounts = [],
  sites = [],
  links = [],
  isGuest = false,
  onArchiveGoogleAccount,
  onRemoveGoogleAccount,
  onAddSite,
  onRemoveSite,
  onAddLink,
  onRemoveLink,
  onRefresh,
}: IntegrationsPanelProps) => {
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [apiSet, setApiSet] = useState(1);
  const [connecting, setConnecting] = useState(false);
  const [syncingAds, setSyncingAds] = useState(false);
  const [syncingGam, setSyncingGam] = useState(false);
  const refresh = async () => { await onRefresh?.(); };

  useEffect(() => {
    supabase.functions
      .invoke<OAuthStatus>("google-ads-oauth-status")
      .then(({ data }) => {
        setStatus(data ?? null);
        if (data?.default_api_set) setApiSet(data.default_api_set);
      })
      .catch(() => setStatus(null));
  }, []);

  const configuredSets = status?.configured_api_sets ?? (status?.configured ? [1] : []);
  const mccAccounts = useMemo(() => googleAccounts.filter((a) => a.is_mcc), [googleAccounts]);
  const childAccounts = useMemo(() => googleAccounts.filter((a) => !a.is_mcc), [googleAccounts]);

  const handleConnect = async () => {
    setConnecting(true);
    const redirectUri = `${window.location.origin}/oauth/google-ads/callback`;
    try {
      sessionStorage.setItem(
        "oauth_pending",
        JSON.stringify({ account_name: `MCC (API ${apiSet})`, api_set: apiSet }),
      );
      const { data, error } = await supabase.functions.invoke<{ auth_url?: string; error?: string }>(
        "google-ads-oauth-start",
        { body: { redirect_uri: redirectUri, api_set: apiSet } },
      );
      if (error || !data?.auth_url) {
        toast({
          title: "Não foi possível iniciar o OAuth",
          description: data?.error ?? error?.message ?? "Verifique os secrets do Google no Supabase.",
          variant: "destructive",
        });
        setConnecting(false);
        return;
      }
      window.location.href = data.auth_url;
    } catch (e) {
      toast({ title: "Erro ao conectar", description: String(e), variant: "destructive" });
      setConnecting(false);
    }
  };

  const handleSyncAds = async () => {
    if (isGuest) {
      toast({ title: "Sessão necessária", description: "Faça login para sincronizar dados reais.", variant: "destructive" });
      return;
    }
    setSyncingAds(true);
    try {
      const { data, error } = await supabase.functions.invoke<{
        ok?: boolean;
        summary?: Array<{ root_account?: string; total_campaigns_synced?: number; total_metric_rows?: number; error?: string }>;
        errors?: Array<{ account_id: string; error: string }>;
        error?: string;
      }>("google-ads-sync-campaigns", { body: { window_days: 30 } });
      if (error || data?.error) throw new Error(data?.error ?? error?.message);
      const camps = (data?.summary ?? []).reduce((s, x) => s + (x.total_campaigns_synced ?? 0), 0);
      const rows = (data?.summary ?? []).reduce((s, x) => s + (x.total_metric_rows ?? 0), 0);
      const errs = data?.errors ?? [];
      toast({
        title: errs.length ? "Sincronização parcial" : "Google Ads sincronizado",
        description: `${camps} campanha(s), ${rows} linha(s) de métrica.${errs.length ? ` ${errs.length} conta(s) com erro.` : ""}`,
        variant: errs.length ? "destructive" : "default",
      });
      await refresh();
    } catch (e) {
      toast({ title: "Erro no sync do Google Ads", description: String((e as Error).message ?? e), variant: "destructive" });
    } finally {
      setSyncingAds(false);
    }
  };

  const handleSyncGam = async () => {
    if (isGuest) {
      toast({ title: "Sessão necessária", description: "Faça login para sincronizar dados reais.", variant: "destructive" });
      return;
    }
    if (sites.length === 0) {
      toast({ title: "Cadastre um site primeiro", description: "O GAM sincroniza por site (network code).", variant: "destructive" });
      return;
    }
    setSyncingGam(true);
    try {
      for (const preset of ["YESTERDAY", "TODAY"]) {
        const { error } = await supabase.functions.invoke("gam-sync-revenue", {
          body: { sync: true, date_preset: preset },
        });
        if (error) throw error;
      }
      toast({ title: "Receita GAM sincronizada", description: "Ontem + hoje processados. eCPM/receita por campanha via UTM." });
      await refresh();
    } catch (e) {
      toast({ title: "Erro no sync do GAM", description: String(e), variant: "destructive" });
    } finally {
      setSyncingGam(false);
    }
  };

  const redirectHint = typeof window !== "undefined"
    ? `${window.location.origin}/oauth/google-ads/callback`
    : "";

  return (
    <div className="space-y-6">
      {isGuest && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <span>
            Você está em <strong>modo livre / bypass sem sessão</strong>. Conectar contas e sincronizar
            exige uma sessão real — defina <code className="font-mono">VITE_DEV_LOGIN_EMAIL</code> e{" "}
            <code className="font-mono">VITE_DEV_LOGIN_PASSWORD</code> no Vercel (ou desligue o bypass e faça login).
          </span>
        </div>
      )}

      {/* 1 — Google Ads (OAuth) */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-elegant space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Plug className="h-4 w-4" /> Google Ads
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              OAuth do MCC. Após conectar, sincronize contas + campanhas + gasto.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {status
              ? status.configured
                ? <Badge variant="secondary" className="gap-1 text-success"><CheckCircle2 className="h-3 w-3" /> credenciais OK</Badge>
                : <Badge variant="secondary" className="gap-1 text-destructive"><XCircle className="h-3 w-3" /> secrets faltando</Badge>
              : <Badge variant="secondary" className="gap-1"><RefreshCw className="h-3 w-3 animate-spin" /> verificando…</Badge>}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {(status?.api_sets?.filter((s) => s.configured).length ?? 0) > 1 && (
            <div className="space-y-1">
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <KeyRound className="h-3 w-3" /> Conjunto de credenciais
              </label>
              <Select value={String(apiSet)} onValueChange={(v) => setApiSet(Number(v))}>
                <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(status?.api_sets ?? []).filter((s) => s.configured).map((s) => (
                    <SelectItem key={s.api_set} value={String(s.api_set)}>
                      MCC {s.api_set}{s.api_set === 1 ? " (principal)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button
            onClick={handleConnect}
            disabled={connecting || !configuredSets.includes(apiSet)}
            className="gap-1.5"
          >
            <Plug className="h-3.5 w-3.5" />
            {connecting ? "Redirecionando…" : "Conectar Google Ads (MCC)"}
          </Button>
          <Button
            variant="outline"
            onClick={handleSyncAds}
            disabled={syncingAds || googleAccounts.length === 0}
            className="gap-1.5"
          >
            <RefreshCw className={syncingAds ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            Sincronizar contas e campanhas
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Redirect URI (registre no Google Cloud): <code className="font-mono">{redirectHint}</code>
        </p>

        {googleAccounts.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border">
            <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              {mccAccounts.length} MCC · {childAccounts.length} conta(s) operacional(is)
            </div>
            {googleAccounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium truncate">{a.account_name ?? a.descriptive_name ?? a.customer_id}</span>
                  <span className="ml-2 text-[11px] text-muted-foreground font-mono">{formatCid(a.customer_id)}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {a.currency && <Badge variant="outline" className="text-[10px]">{a.currency}</Badge>}
                  {a.is_mcc && <Badge variant="secondary" className="text-[10px] gap-1"><Building2 className="h-3 w-3" /> MCC</Badge>}
                  {a.api_set && a.api_set > 1 && <Badge variant="outline" className="text-[10px]">API {a.api_set}</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2 — Google Ad Manager */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-elegant space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <RefreshCw className={syncingGam ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Google Ad Manager
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Autentica via Service Account (secret <code className="font-mono">GAM_SERVICE_ACCOUNT_JSON</code>).
              Sincroniza por site usando o <strong>network code</strong>.
            </p>
          </div>
          <Button variant="outline" onClick={handleSyncGam} disabled={syncingGam} className="gap-1.5">
            <RefreshCw className={syncingGam ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            Sincronizar receita (ontem + hoje)
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          O cruzamento <strong>Campaign ID → UTM → GAM → Receita → ROI</strong> depende de: (1) UTM padrão
          aplicado nas campanhas pelo sync do Google Ads, e (2) o site correto vinculado à conta Ads abaixo.
        </p>
        {gamAccounts.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            Networks: {gamAccounts.map((g) => g.network_code).join(", ")}
          </div>
        )}
      </section>

      {/* 3 — Sites (GAM) */}
      {onAddSite && onRemoveSite && (
        <SitesPanel sites={sites} onAdd={onAddSite} onRemove={onRemoveSite} />
      )}

      {/* 4 — Mapeamento Ads ↔ Site */}
      {onAddLink && onRemoveLink && (
        <AccountSiteMappingPanel
          accounts={googleAccounts}
          sites={sites}
          links={links}
          isGuest={isGuest}
          onAddLink={onAddLink}
          onRemoveLink={onRemoveLink}
          onArchiveAccount={onArchiveGoogleAccount}
          onRemoveAccount={onRemoveGoogleAccount}
          onRefresh={refresh}
        />
      )}

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Link2 className="h-3 w-3" />
        Ordem: 1) Conectar Google Ads · 2) Sincronizar contas e campanhas · 3) Cadastrar site(s) com network code ·
        4) Vincular cada conta Ads ao seu site · 5) Sincronizar receita GAM.
      </div>
    </div>
  );
};
