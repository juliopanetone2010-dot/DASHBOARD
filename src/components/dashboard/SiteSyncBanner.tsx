import { Loader2, AlertTriangle, RefreshCw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSiteOnboarding } from "@/hooks/useSiteOnboarding";

interface Props {
  siteId: string;
  siteName?: string;
}

/** Banner exibido quando um site recém-selecionado está sendo sincronizado
 *  ou quando há algum problema com vínculos (Google Ads / GAM). */
export function SiteSyncBanner({ siteId, siteName }: Props) {
  const { state, refresh } = useSiteOnboarding(siteId);
  if (siteId === "all" || !state) return null;

  // Aviso de vínculos faltando
  if (!state.hasAdsLink || !state.hasGamLink) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
        <div className="flex-1">
          <div className="font-medium">Este site ainda não está totalmente conectado</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {!state.hasAdsLink && <>• Sem conta Google Ads vinculada{!state.hasGamLink && " "}</>}
            {!state.hasGamLink && <>• Sem GAM vinculado</>}
            <br />Vá em <b>Integrações → Mapeamento de contas</b> para conectar.
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "processing") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
        <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
        <div className="flex-1">
          <div className="font-medium">Coletando dados de {siteName ?? "site"}…</div>
          <div className="text-xs text-muted-foreground">
            Buscando campanhas, placements e receita desde o primeiro dia em que a campanha do Google Ads foi marcada com o parâmetro UTM deste site.
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
        <div className="flex-1">
          <div className="font-medium">Falha na sincronização inicial</div>
          <div className="text-xs text-muted-foreground mt-0.5 break-all">{state.error ?? "erro desconhecido"}</div>
        </div>
        <Button size="sm" variant="outline" onClick={() => refresh(true)} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" /> Tentar novamente
        </Button>
      </div>
    );
  }

  // completed: mostra um sutil indicador + botão pra re-rodar
  if (state.status === "completed") {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/5 px-4 py-2 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        <span>
          Site sincronizado{state.lastFullSyncAt ? ` em ${new Date(state.lastFullSyncAt).toLocaleString("pt-BR")}` : ""}.
        </span>
        <Button size="sm" variant="ghost" onClick={() => refresh(true)} className="ml-auto h-7 gap-1.5 text-xs">
          <RefreshCw className="h-3 w-3" /> Sincronizar dados do site
        </Button>
      </div>
    );
  }

  return null;
}
