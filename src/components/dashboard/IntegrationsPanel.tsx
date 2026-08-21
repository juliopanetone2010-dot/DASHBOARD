import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Plug, RefreshCw, RotateCcw, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { SitesPanel } from "./SitesPanel";
import { AccountSiteMappingPanel } from "./AccountSiteMappingPanel";
import type {
  AccountSiteLink, GamAccount, GoogleAccount, Site,
} from "@/types/domain";

interface ApiSetStatus {
  api_set: number;
  client_id: boolean;
  client_secret: boolean;
  developer_token: boolean;
  configured: boolean;
}

interface OAuthStatusResp {
  api_sets?: ApiSetStatus[];
  configured_api_sets?: number[];
  default_api_set?: number;
}

interface Props {
  googleAccounts: GoogleAccount[];
  gamAccounts: GamAccount[];
  sites: Site[];
  links: AccountSiteLink[];
  isGuest: boolean;
  onAddGoogleAccount: (input: Partial<GoogleAccount>) => Promise<void>;
  onArchiveGoogleAccount: (id: string) => Promise<void>;
  onRemoveGoogleAccount: (id: string) => Promise<void>;
  onAddGamAccount: (input: Partial<GamAccount>) => Promise<void>;
  onRemoveGamAccount: (id: string) => Promise<void>;
  onAddSite: (input: Partial<Site>) => Promise<void>;
  onRemoveSite: (id: string) => Promise<void>;
  onAddLink: (googleAccountId: string, siteId: string) => Promise<void>;
  onRemoveLink: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function IntegrationsPanel(props: Props) {
  const [gamName, setGamName] = useState("");
  const [gamNetwork, setGamNetwork] = useState("");
  const [gamEmail, setGamEmail] = useState("");
  const [gamKey, setGamKey] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncingGam, setSyncingGam] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatusResp | null>(null);
  const [apiSet, setApiSet] = useState(1);
  const [connecting, setConnecting] = useState(false);
  const [manualAccountName, setManualAccountName] = useState("");
  const [manualCustomerId, setManualCustomerId] = useState("");
  const [addingManual, setAddingManual] = useState(false);
  const [manualDevToken, setManualDevToken] = useState("");
  const [manualClientId, setManualClientId] = useState("");
  const [manualClientSecret, setManualClientSecret] = useState("");
  const [savingSecret, setSavingSecret] = useState(false);
  const [listingAccounts, setListingAccounts] = useState(false);
  const [accessibleAccounts, setAccessibleAccounts] = useState<any[]>([]);
  const [showAccountSelector, setShowAccountSelector] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.functions.invoke<OAuthStatusResp>("google-ads-oauth-status");
      if (data) {
        setOauthStatus(data);
        if (data.default_api_set) setApiSet(data.default_api_set);
      }
    })();
  }, []);

  const apiSets = oauthStatus?.api_sets ?? [];
  const configuredSets = oauthStatus?.configured_api_sets ?? [];

  const handleConnectAds = async () => {
    // Abra a janela durante o clique do usuário. Se ela for criada apenas após
    // o await, Chrome pode tratá-la como popup ou mantê-la dentro do preview.
    const oauthWindow = window.open("about:blank", "google-ads-oauth");
    setConnecting(true);
    const redirectUri = `${window.location.origin}/oauth/google-ads/callback`;
    sessionStorage.setItem(
      "oauth_pending",
      JSON.stringify({ account_name: `MCC (API ${apiSet})`, api_set: apiSet }),
    );
    try {
      // Usar a URL absoluta do backend para evitar problemas de proxy e CORS no preview
      const { data, error } = await supabase.functions.invoke("google-ads-oauth-start", {
        body: {
          redirect_uri: redirectUri,
          api_set: apiSet
        }
      });

      if (error || !data?.auth_url) {
        oauthWindow?.close();
        toast({
          title: "Erro na Conexão",
          description: data?.error || error?.message || "Falhou ao obter URL de autenticação",
          variant: "destructive",
        });
        setConnecting(false);
        return;
      }

      if (oauthWindow) {
        // Redirecionamento direto para o Google
        oauthWindow.location.href = data.auth_url;
      } else {
        // Fallback caso o popup tenha sido bloqueado mesmo após o clique
        window.top.location.href = data.auth_url;
      }
    } catch (e) {
      oauthWindow?.close();
      toast({ title: "Erro ao iniciar OAuth", description: String(e), variant: "destructive" });
      setConnecting(false);
    }
  };

  const handleSyncGam = async () => {
    setSyncingGam(true);
    const { data, error } = await supabase.functions.invoke<{
      ok?: boolean; error?: string; summary?: any[]; debug?: string[];
    }>("gam-sync-revenue", { body: { date_preset: "LAST_7_DAYS", revenue_only: true } });
    setSyncingGam(false);
    console.log("[gam-sync-revenue] response", data, error);
    if (error || data?.error) {
      toast({
        title: "Erro ao sincronizar GAM",
        description: data?.error ?? error?.message ?? "Falha desconhecida",
        variant: "destructive",
      });
      return;
    }
    const summary = (data?.summary ?? []) as any[];
    const totalRev = summary.reduce((acc, s) => acc + (Number(s.total_revenue) || 0), 0);
    const totalRows = summary.reduce(
      (acc, s) => acc + (Number(s.ad_unit_rows) || 0) + (Number(s.placement_rows) || 0), 0,
    );
    const errs = summary.filter((s) => s.error).map((s) => `${s.network_code}: ${String(s.error).replace(/^Error:\s*/, "")}`);
    if (errs.length > 0) {
      toast({
        title: "GAM retornou erro",
        description: errs.join(" | ").slice(0, 300),
        variant: "destructive",
      });
    } else if (totalRows === 0) {
      toast({
        title: "Sincronizado, mas sem dados",
        description: "GAM autenticou mas não retornou linhas. Verifique permissão da Service Account (função 'Ver/Executar relatórios') e se há receita no período.",
      });
    } else {
      toast({
        title: "Receita GAM sincronizada",
        description: `R$ ${totalRev.toFixed(2)} • ${totalRows} linha(s) (últimos 7 dias)`,
      });
    }
    await props.onRefresh();
  };

  const handleSyncCampaigns = async (deep = false) => {
    setSyncing(true);
    const { data, error } = await supabase.functions.invoke<{
      ok?: boolean; error?: string; summary?: unknown[]; debug?: string[];
    }>("google-ads-sync-campaigns", { 
      body: { 
        window_days: deep ? 90 : 30 
      } 
    });
    setSyncing(false);
    console.log("[sync-campaigns] response", data, error);
    if (error || data?.error) {
      toast({
        title: "Erro ao sincronizar",
        description: data?.error ?? error?.message ?? "Falha desconhecida",
        variant: "destructive",
      });
      return;
    }
    const total = (data?.summary ?? []).reduce((acc: number, s) => {
      const x = s as { total_campaigns_synced?: number };
      return acc + (x.total_campaigns_synced ?? 0);
    }, 0);
    toast({ 
      title: deep ? "Sincronização profunda completa" : "Sincronização completa", 
      description: `${total} campanha(s) sincronizada(s). Se os dados antigos ainda não aparecerem, aguarde alguns minutos.` 
    });
    await props.onRefresh();
  };

  const handleAddGam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gamNetwork.trim()) {
      toast({ title: "Network code obrigatório", variant: "destructive" });
      return;
    }
    await props.onAddGamAccount({
      network_code: gamNetwork.trim(),
      account_name: gamName.trim() || null,
      service_account_email: gamEmail.trim() || null,
      status: gamKey ? "connected" : "pending",
    });
    setGamName(""); setGamNetwork(""); setGamEmail(""); setGamKey("");
    toast({ title: "GAM cadastrado" });
  };

  const handleAddManualAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCustomerId.trim()) {
      toast({ title: "Customer ID obrigatório", variant: "destructive" });
      return;
    }
    setAddingManual(true);
    try {
      await props.onAddGoogleAccount({
        customer_id: manualCustomerId.trim(),
        account_name: manualAccountName.trim() || `Conta ${manualCustomerId}`,
        status: "connected",
        is_mcc: false,
      });
      setManualAccountName("");
      setManualCustomerId("");
      toast({ title: "Conta adicionada manualmente" });
    } finally {
      setAddingManual(false);
    }
  };

  const handleSaveDevToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualDevToken.trim()) {
      toast({ title: "Developer Token obrigatório", variant: "destructive" });
      return;
    }
    setSavingSecret(true);
    try {
      // Salva Developer Token
      const devTokenName = `GOOGLE_ADS_DEVELOPER_TOKEN_${apiSet}`;
      await supabase.functions.invoke("secrets-manager", {
        body: { action: "set", name: devTokenName, value: manualDevToken.trim() }
      });

      // Salva Client ID se fornecido
      if (manualClientId.trim()) {
        await supabase.functions.invoke("secrets-manager", {
          body: { action: "set", name: `GOOGLE_CLIENT_ID_${apiSet}`, value: manualClientId.trim() }
        });
      }

      // Salva Client Secret se fornecido
      if (manualClientSecret.trim()) {
        await supabase.functions.invoke("secrets-manager", {
          body: { action: "set", name: `GOOGLE_CLIENT_SECRET_${apiSet}`, value: manualClientSecret.trim() }
        });
      }

      toast({ title: "Credenciais salvas", description: `Conjunto ${apiSet} atualizado com sucesso.` });
      setManualDevToken("");
      setManualClientId("");
      setManualClientSecret("");
      
      // Refresh status
      const { data } = await supabase.functions.invoke<OAuthStatusResp>("google-ads-oauth-status");
      if (data) setOauthStatus(data);
    } catch (e) {
      toast({ title: "Erro ao salvar credenciais", description: String(e), variant: "destructive" });
    } finally {
      setSavingSecret(false);
    }
  };

  const handleListAccounts = async () => {
    setListingAccounts(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-ads-list-accounts", {
        body: { api_set: apiSet, force_all: true }
      });
      if (error) throw error;
      
      // A função retorna { summary: [...] } onde summary contém detalhes do MCC e contas filhas
      // ou pode retornar direto a lista dependendo da implementação. 
      // Ajustamos para o formato esperado pelo usuário.
      const accounts = (data as any)?.summary || [];
      setAccessibleAccounts(accounts);
      setShowAccountSelector(true);
      toast({ title: "Contas listadas", description: "Selecione as contas que deseja vincular." });
    } catch (e) {
      toast({ title: "Erro ao listar contas", description: String(e), variant: "destructive" });
    } finally {
      setListingAccounts(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-success" />
        Conexão segura via OAuth. Refresh tokens armazenados no backend.
      </div>

      {/* Conexões */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card p-5 shadow-elegant">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-10 w-10 rounded-lg bg-gradient-primary flex items-center justify-center">
              <Plug className="h-4 w-4 text-primary-foreground" />
            </div>
            <div>
              <h3 className="font-semibold">Google Ads — MCC</h3>
              <p className="text-xs text-muted-foreground">Conecte a conta gerenciadora (MCC)</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Sem digitar Customer ID. Ao autorizar, o sistema lista automaticamente as sub-contas
            disponíveis no MCC (nome, ID e moeda).
          </p>
          <div className="space-y-1 mb-3">
            <Label className="text-xs">Conjunto de credenciais (API)</Label>
            <select
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={apiSet}
              onChange={(e) => setApiSet(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((i) => {
                const s = apiSets.find((x) => x.api_set === i);
                const isConfigured = s?.configured ?? false;
                return (
                  <option key={i} value={i}>
                    Conjunto {i}{i === 1 ? " (MCC original)" : ""}
                    {isConfigured ? "" : " — não configurado"}
                  </option>
                );
              })}
            </select>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {apiSets.map((s) => (
                <span
                  key={s.api_set}
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
                    s.configured ? "border-success/40 text-success" : "border-border text-muted-foreground"
                  }`}
                >
                  {s.configured ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                  API {s.api_set}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground pt-1">
              Cada conjunto = uma MCC / developer token separado.
            </p>
            <form onSubmit={handleSaveDevToken} className="mt-2 space-y-2 border-t border-border/50 pt-2">
              <div className="flex flex-col gap-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Configurar Credenciais (Conjunto {apiSet})
                </Label>
                <div className="flex flex-col gap-2">
                  <Input 
                    type="password"
                    value={manualDevToken}
                    onChange={(e) => setManualDevToken(e.target.value)}
                    placeholder="Insira o Developer Token aqui..."
                    className="h-8 text-xs"
                  />
                  <div className="flex gap-2">
                    <Input 
                      type="password"
                      value={manualClientId}
                      onChange={(e) => setManualClientId(e.target.value)}
                      placeholder="Client ID (Opcional se global)"
                      className="h-8 text-xs flex-1"
                    />
                    <Input 
                      type="password"
                      value={manualClientSecret}
                      onChange={(e) => setManualClientSecret(e.target.value)}
                      placeholder="Client Secret (Opcional)"
                      className="h-8 text-xs flex-1"
                    />
                  </div>
                  <Button 
                    onClick={handleSaveDevToken}
                    size="sm" 
                    className="h-8 w-full" 
                    disabled={savingSecret}
                  >
                    {savingSecret ? <Loader2 className="h-3 w-3 animate-spin" /> : "Salvar Conjunto"}
                  </Button>
                </div>
              </div>
              
              <div className="bg-red-500/10 border border-red-500/30 rounded-md p-3 mt-2 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                  <p className="text-[11px] text-red-400 font-bold uppercase tracking-tight">
                    CONTINUA A MESMA COISA GASTOS ZERADOS E BOTAO ATUALIZAR SUMIU, O TOKEN FOI EXPIRADO VERIFIQUE PRA MIM
                  </p>
                </div>
                
                <div className="space-y-3">
                  <div className="space-y-1">
                    <p className="text-[10px] text-amber-100/90 font-semibold">
                      Passo 1: Acesse o Google Cloud Console
                    </p>
                    <p className="text-[9px] text-amber-200/70 leading-relaxed">
                      Vá em <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noreferrer" className="underline decoration-amber-500/50 hover:text-amber-100">Tela de consentimento OAuth</a>.
                    </p>
                  </div>

                  <div className="space-y-1 border-t border-amber-500/20 pt-2">
                    <p className="text-[10px] text-amber-100/90 font-semibold">
                      Passo 2: Verifique o Status de Publicação
                    </p>
                    <p className="text-[9px] text-amber-200/70 leading-relaxed">
                      Se estiver em <strong>"Em teste"</strong> (Testing), você deve descer até a seção <strong>"Usuários de teste"</strong> e clicar em <strong>"+ ADD USERS"</strong> para colocar o e-mail da MCC que quer conectar.
                    </p>
                    <p className="text-[9px] text-amber-200/70 leading-relaxed italic">
                      Dica: Se preferir não precisar adicionar e-mails, clique em <strong>"PUBLICAR APLICATIVO"</strong> logo acima para mudar para "Produção".
                    </p>
                  </div>

                  <div className="bg-black/20 p-2 rounded text-[9px] text-amber-200/60 font-mono">
                    Google Cloud &gt; APIs e Serviços &gt; Tela de consentimento &gt; Usuários de teste
                  </div>
                </div>
              </div>

              <p className="text-[9px] text-muted-foreground italic mt-1">
                O token será armazenado com segurança como secret no backend.
              </p>
            </form>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleConnectAds}
              size="sm"
              className="gap-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
              disabled={connecting}
            >
              {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
              1. Conectar MCC
            </Button>

            <Button
              onClick={handleListAccounts}
              size="sm"
              variant="secondary"
              className="gap-1.5"
              disabled={listingAccounts || connecting}
            >
              {listingAccounts ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              2. Selecionar Contas
            </Button>

            <Button onClick={() => handleSyncCampaigns(false)} size="sm" variant="outline" disabled={syncing} className="gap-1.5">
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              3. Sincronizar (30d)
            </Button>

            <Button onClick={() => handleSyncCampaigns(true)} size="sm" variant="ghost" disabled={syncing} className="gap-1.5 text-[10px] h-8">
              Deep Sync (90d)
            </Button>
          </div>

          {showAccountSelector && (
            <div className="mt-4 p-4 border border-dashed border-border rounded-lg bg-muted/20 animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold">Contas encontradas no MCC</h4>
                <Button variant="ghost" size="sm" onClick={() => setShowAccountSelector(false)} className="h-7 text-xs">Fechar</Button>
              </div>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                {accessibleAccounts.length === 0 ? (
                  <div className="text-center py-4 space-y-2">
                    <p className="text-xs text-muted-foreground">Nenhuma conta encontrada vinculada a este MCC.</p>
                    <p className="text-[10px] text-muted-foreground italic">Certifique-se de que a conta 719-750-3782 é a que foi conectada no "Passo 1".</p>
                  </div>
                ) : (
                  accessibleAccounts.map((mcc: any) => (
                    <div key={mcc.manager} className="space-y-1.5 mb-3 last:mb-0">
                      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">MCC: {mcc.manager}</p>
                      {mcc.error ? (
                        <p className="text-[10px] text-destructive italic">{mcc.error}</p>
                      ) : mcc.synced > 0 ? (
                        <div className="flex items-center gap-2 text-xs text-success bg-success/5 p-2 rounded border border-success/20">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {mcc.synced} conta(s) sincronizada(s) e disponível(is) para mapeamento.
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">Nenhuma conta ativa encontrada nessa MCC.</p>
                      )}
                    </div>
                  ))
                )}
              </div>
              {accessibleAccounts.length > 0 && (
                <p className="text-[10px] text-muted-foreground mt-3 italic">
                  * As contas importadas aparecem automaticamente na seção "Mapeamento Ads ↔ Site" abaixo.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <form onSubmit={handleAddGam} className="rounded-xl border border-border bg-card p-5 shadow-elegant space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-accent flex items-center justify-center">
                <Plug className="h-4 w-4 text-accent-foreground" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">Google Ad Manager</h3>
                <p className="text-[11px] text-muted-foreground">Service Account</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Nome</Label>
                <Input value={gamName} onChange={(e) => setGamName(e.target.value)} placeholder="Rede principal" className="h-8 text-xs" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Network code</Label>
                <Input value={gamNetwork} onChange={(e) => setGamNetwork(e.target.value)} placeholder="21700000" className="h-8 text-xs" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Email da Service Account</Label>
              <Input value={gamEmail} onChange={(e) => setGamEmail(e.target.value)} placeholder="acc@projeto.iam.gserviceaccount.com" className="h-8 text-xs" />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="submit" size="sm" className="h-7 text-[11px]">Salvar GAM</Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={syncingGam}
                onClick={handleSyncGam}
                className="h-7 text-[11px] gap-1"
              >
                {syncingGam ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Sincronizar
              </Button>
            </div>
          </form>

          <form onSubmit={handleAddManualAccount} className="rounded-xl border border-border bg-card p-5 shadow-elegant space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-accent/50 flex items-center justify-center">
                <Plug className="h-4 w-4 text-accent-foreground" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">Adicionar Conta Ads Manual</h3>
                <p className="text-[11px] text-muted-foreground">Para contas que não aparecem no MCC</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Nome da Conta</Label>
                <Input 
                  value={manualAccountName} 
                  onChange={(e) => setManualAccountName(e.target.value)} 
                  placeholder="Minha Conta" 
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Customer ID</Label>
                <Input 
                  value={manualCustomerId} 
                  onChange={(e) => setManualCustomerId(e.target.value)} 
                  placeholder="123-456-7890" 
                  className="h-8 text-xs"
                />
              </div>
            </div>
            <Button type="submit" size="sm" className="h-7 text-[11px] w-full" disabled={addingManual}>
              {addingManual ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Adicionar Manualmente
            </Button>
          </form>
        </div>
      </div>

      {/* Sites */}
      <SitesPanel
        sites={props.sites}
        onAdd={props.onAddSite}
        onRemove={props.onRemoveSite}
      />

      {/* Mapeamento visual conta ↔ site (1:1) */}
      <AccountSiteMappingPanel
        accounts={props.googleAccounts}
        sites={props.sites}
        links={props.links}
        isGuest={props.isGuest}
        onAddLink={props.onAddLink}
        onRemoveLink={props.onRemoveLink}
        onArchiveAccount={props.onArchiveGoogleAccount}
        onRemoveAccount={props.onRemoveGoogleAccount}
        onRefresh={props.onRefresh}
      />

      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">Como o cruzamento funciona</p>
        <p>
          Conta Ads → Campanhas → UTMs → Site → Receita GAM.
          Suas tags Ads devem usar:&nbsp;
          <code className="font-mono">utm_campaign={'{campaignid}'}</code>,&nbsp;
          <code className="font-mono">utm_content={'{creative}'}</code>,&nbsp;
          <code className="font-mono">utm_placement={'{campaignid}_{placement}'}</code>.
          O sistema cruza <code>placement_key</code> do GAM com <code>campaign_id</code> do Ads
          via vínculo conta↔site para atribuir receita à campanha correta e calcular ROI.
        </p>
      </div>
    </div>
  );
}
