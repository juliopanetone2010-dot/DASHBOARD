import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ExternalLink, Lock, Plug, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { AccountsPanel } from "./AccountsPanel";
import { SitesPanel } from "./SitesPanel";
import { LinksPanel } from "./LinksPanel";
import type {
  AccountSiteLink, GamAccount, GoogleAccount, Site,
} from "@/types/domain";

interface Props {
  googleAccounts: GoogleAccount[];
  gamAccounts: GamAccount[];
  sites: Site[];
  links: AccountSiteLink[];
  isGuest: boolean;
  onAddGoogleAccount: (input: Partial<GoogleAccount>) => Promise<void>;
  onRemoveGoogleAccount: (id: string) => Promise<void>;
  onAddGamAccount: (input: Partial<GamAccount>) => Promise<void>;
  onRemoveGamAccount: (id: string) => Promise<void>;
  onAddSite: (input: Partial<Site>) => Promise<void>;
  onRemoveSite: (id: string) => Promise<void>;
  onAddLink: (googleAccountId: string, siteId: string) => Promise<void>;
  onRemoveLink: (id: string) => Promise<void>;
}

export function IntegrationsPanel(props: Props) {
  const [gamName, setGamName] = useState("");
  const [gamNetwork, setGamNetwork] = useState("");
  const [gamEmail, setGamEmail] = useState("");
  const [gamKey, setGamKey] = useState("");

  const handleConnectAds = async () => {
    toast({
      title: "OAuth Google Ads",
      description: "Para ativar o fluxo OAuth real, eu preciso configurar GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_ADS_DEVELOPER_TOKEN. Me peça para fazer isso e eu pulo a edge function de callback.",
    });
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
    toast({
      title: "GAM cadastrado",
      description: gamKey
        ? "Para usar de verdade, eu preciso salvar a chave da Service Account como secret. Me peça para configurar GAM_SERVICE_ACCOUNT_JSON."
        : "Cadastrado. Adicione a chave depois.",
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-success" />
        Logado como <span className="font-mono">{user.email}</span> — dados isolados via RLS.
      </div>

      {/* Botões OAuth */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card p-5 shadow-elegant">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-10 w-10 rounded-lg bg-gradient-primary flex items-center justify-center">
              <Plug className="h-4 w-4 text-primary-foreground" />
            </div>
            <div>
              <h3 className="font-semibold">Google Ads OAuth</h3>
              <p className="text-xs text-muted-foreground">Conectar conta MCC ou individual</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Cadastre primeiro suas contas Ads abaixo (customer_id), depois conecte cada uma via OAuth.
            A automação de import de campanhas/gasto roda em edge function periódica.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleConnectAds} size="sm" className="gap-1.5">
              <Plug className="h-3.5 w-3.5" /> Conectar Google Ads
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="https://developers.google.com/google-ads/api/docs/oauth/overview" target="_blank" rel="noreferrer">
                Docs <ExternalLink className="h-3 w-3 ml-1.5" />
              </a>
            </Button>
          </div>
        </div>

        <form onSubmit={handleAddGam} className="rounded-xl border border-border bg-card p-5 shadow-elegant space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-accent flex items-center justify-center">
              <Plug className="h-4 w-4 text-accent-foreground" />
            </div>
            <div>
              <h3 className="font-semibold">Google Ad Manager (Service Account)</h3>
              <p className="text-xs text-muted-foreground">Network code + chave JSON</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Nome</Label>
              <Input value={gamName} onChange={(e) => setGamName(e.target.value)} placeholder="Rede principal" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Network code</Label>
              <Input value={gamNetwork} onChange={(e) => setGamNetwork(e.target.value)} placeholder="21700000" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Service account email</Label>
            <Input value={gamEmail} onChange={(e) => setGamEmail(e.target.value)} placeholder="acc@projeto.iam.gserviceaccount.com" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Chave JSON (será salva como secret na Fase 2)</Label>
            <Textarea value={gamKey} onChange={(e) => setGamKey(e.target.value)}
              placeholder="Cole aqui o JSON da Service Account (não envie pelo chat — peça para configurar como secret)"
              className="h-20 font-mono text-xs" />
          </div>
          <Button type="submit" size="sm">Salvar GAM</Button>
        </form>
      </div>

      {/* Multi-conta */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AccountsPanel
          accounts={props.googleAccounts}
          onAdd={props.onAddGoogleAccount}
          onRemove={props.onRemoveGoogleAccount}
          isGuest={props.isGuest}
        />
        <SitesPanel
          sites={props.sites}
          onAdd={props.onAddSite}
          onRemove={props.onRemoveSite}
        />
      </div>

      <LinksPanel
        links={props.links}
        accounts={props.googleAccounts}
        sites={props.sites}
        onAdd={props.onAddLink}
        onRemove={props.onRemoveLink}
      />

      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">Como o match UTM funciona</p>
        <p>
          Suas tags Ads devem usar:&nbsp;
          <code className="font-mono">utm_campaign={'{campaignid}'}</code>,&nbsp;
          <code className="font-mono">utm_content={'{creative}'}</code>,&nbsp;
          <code className="font-mono">utm_placement={'{campaignid}_placement'}</code>.
          O sistema cruza a coluna <code>placement_key</code> do GAM com o <code>campaign_id</code> do Ads
          através do vínculo conta↔site, para atribuir receita à campanha correta.
        </p>
      </div>
    </div>
  );
}
