import { Construction, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export function IntegrationsPanel() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-6 shadow-elegant">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-accent flex items-center justify-center shrink-0">
            <Construction className="h-5 w-5 text-accent-foreground" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <h2 className="text-lg font-semibold">Integrações Google Ads & Ad Manager</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Esta é a Fase 1 do sistema: backend, engine de regras, alertas e
                rankings já estão funcionais. As conexões OAuth com Google Ads e
                a Service Account do Ad Manager entram nas próximas fases.
              </p>
            </div>

            <div className="rounded-lg bg-muted/50 p-4 text-sm space-y-2">
              <p className="font-semibold">Próximos passos (Fase 2 e 3)</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground text-xs">
                <li><b>Google Ads OAuth:</b> precisarei do seu Developer Token, OAuth Client ID/Secret e Customer ID do MCC.</li>
                <li><b>Google Ad Manager:</b> precisarei do Network Code e da chave JSON da Service Account.</li>
                <li>Ao confirmar, eu peço cada secret pelo formulário seguro do Lovable Cloud (nunca cole no chat).</li>
                <li>Depois, automatizo importação diária + matching por UTM <code>utm_campaign={'{campaignid}'}</code>.</li>
              </ul>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" size="sm" asChild>
                <a href="https://developers.google.com/google-ads/api/docs/oauth/overview" target="_blank" rel="noreferrer">
                  Docs Google Ads OAuth <ExternalLink className="h-3 w-3 ml-1.5" />
                </a>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a href="https://developers.google.com/ad-manager/api/start" target="_blank" rel="noreferrer">
                  Docs Ad Manager API <ExternalLink className="h-3 w-3 ml-1.5" />
                </a>
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          Enquanto isso, você pode <b>simular</b> dados pela aba "Dashboard" (botão "Inserir dado de teste")
          para ver alertas, rankings e a engine em ação.
        </p>
      </div>
    </div>
  );
}
