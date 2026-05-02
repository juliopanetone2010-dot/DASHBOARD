import { useState } from "react";
import { ExternalLink, Loader2, Plug, RefreshCw, ShieldCheck } from "lucide-react";
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
  onRefresh: () => Promise<void>;
}

export function IntegrationsPanel(props: Props) {
  const [gamName, setGamName] = useState("");
  const [gamNetwork, setGamNetwork] = useState("");
  const [gamEmail, setGamEmail] = useState("");
  const [gamKey, setGamKey] = useState("");

  const handleConnectAds = () => {
    window.location.href = "/settings";
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
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleConnectAds} size="sm" className="gap-1.5">
              <Plug className="h-3.5 w-3.5" /> Conectar MCC
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
        onRefresh={props.onRefresh}
      />

      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">Como o cruzamento funciona</p>
        <p>
          Conta Ads → Campanhas → UTMs → Site → Receita GAM.
          Suas tags Ads devem usar:&nbsp;
          <code className="font-mono">utm_campaign={'{campaignid}'}</code>,&nbsp;
          <code className="font-mono">utm_content={'{creative}'}</code>,&nbsp;
          <code className="font-mono">utm_placement={'{campaignid}_placement'}</code>.
          O sistema cruza <code>placement_key</code> do GAM com <code>campaign_id</code> do Ads
          via vínculo conta↔site para atribuir receita à campanha correta e calcular ROI.
        </p>
      </div>
    </div>
  );
}
