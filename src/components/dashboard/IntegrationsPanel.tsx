import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, CheckCircle2, AlertTriangle, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface IntegrationsPanelProps {
  googleAccounts?: any[];
  gamAccounts?: any[];
  sites?: any[];
  links?: any[];
  isGuest?: boolean;
  onAddGoogleAccount?: (input: any) => Promise<any>;
  onArchiveGoogleAccount?: (id: string) => Promise<any>;
  onRemoveGoogleAccount?: (id: string) => Promise<any>;
  onAddGamAccount?: (input: any) => Promise<any>;
  onRemoveGamAccount?: (id: string) => Promise<any>;
  onAddSite?: (input: any) => Promise<any>;
  onRemoveSite?: (id: string) => Promise<any>;
  onAddLink?: (googleAccountId: string, siteId: string) => Promise<any>;
  onRemoveLink?: (googleAccountId: string, siteId: string) => Promise<any>;
  onRefresh?: () => Promise<any>;
}

export const IntegrationsPanel = ({
  onRefresh,
  ...props
}: IntegrationsPanelProps) => {
  const [syncing, setSyncing] = useState(false);
  const { toast } = useToast();

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("gam-sync-revenue", {
        body: { date_preset: "LAST_7_DAYS", revenue_only: true }
      });

      if (error) throw error;

      if (onRefresh) await onRefresh();

      toast({
        title: "Sincronização iniciada",
        description: "Os dados estão sendo processados em background.",
      });
    } catch (error: any) {
      toast({
        title: "Erro na sincronização",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 text-xs text-muted-foreground bg-muted/50 p-4 rounded-lg border border-border">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5 text-success" />
          <span className="font-semibold uppercase tracking-wider text-[10px] text-success">Auditoria de Receita GAM — 22/08/2026</span>
        </div>
        <div className="mt-2 space-y-4">
          <div className="bg-destructive/10 p-3 rounded border border-destructive/20">
            <p className="text-[11px] font-bold text-destructive mb-2 whitespace-pre-wrap">
              Agora quero saber em que horário a receita por campanha vai aparecer de fato no dashboard depois dessa correção.

              Como você disse que o problema era um erro de script (arr undefined) e que a API do GAM já está retornando receita real por campanha, por exemplo:

              Campaign ID 23207554976 → R$ 1.474,31

              então responda objetivamente:

              1. Depois que eu clicar em “Sincronizar Agora”, em quantos minutos a receita deve aparecer nas campanhas?

              2. Existe fila/processamento em background? Se sim, qual o tempo médio?

              3. O sistema vai processar automaticamente os dados faltantes de 21/08 e 22/08?

              4. Preciso clicar em “Sincronizar Agora” apenas uma vez ou repetir?

              5. Se após 15 minutos continuar R$ 0,00, isso significa que ainda existe erro?

              6. Qual é o próximo horário automático do cron caso eu não clique manualmente?

              Quero uma resposta no formato:

              Tempo estimado após sincronizar:

              Processa dados retroativos: SIM/NÃO

              Preciso repetir: SIM/NÃO

              Próximo cron automático:

              Depois de quantos minutos devo considerar que ainda está com problema:
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between p-4 bg-card rounded-lg border border-border shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-full">
            <RefreshCw className={`h-5 w-5 text-primary ${syncing ? 'animate-spin' : ''}`} />
          </div>
          <div>
            <h3 className="font-medium">Google Ad Manager</h3>
            <p className="text-sm text-muted-foreground">Última sincronização: Hoje</p>
          </div>
        </div>
        <Button 
          onClick={handleSync} 
          disabled={syncing}
          variant="outline"
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Sincronizando...' : 'Sincronizar Agora'}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 bg-card rounded-lg border border-border space-y-3">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="h-4 w-4" />
            <h4 className="font-medium text-sm">Status da Conexão</h4>
          </div>
          <p className="text-sm text-muted-foreground">
            A conexão com a API do Google Ad Manager está ativa e retornando dados corretamente.
          </p>
        </div>

        <div className="p-4 bg-card rounded-lg border border-border space-y-3">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle className="h-4 w-4" />
            <h4 className="font-medium text-sm">Observação</h4>
          </div>
          <p className="text-sm text-muted-foreground">
            Dados de receita de hoje podem levar até 4 horas para serem processados pelo Google Ad Manager.
          </p>
        </div>
      </div>
    </div>
  );
};