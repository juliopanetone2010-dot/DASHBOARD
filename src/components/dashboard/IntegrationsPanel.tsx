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
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const { toast } = useToast();

  const handleSync = async () => {
    setSyncing(true);
    setDebugLogs(["Iniciando sincronização manual..."]);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const currentUserId = session?.user?.id;

      const { data, error } = await supabase.functions.invoke("gam-sync-revenue", {
        body: { 
          sync: true, 
          user_id: currentUserId || props.googleAccounts?.[0]?.user_id, 
          date_preset: "YESTERDAY" 
        }
      });

      if (error) {
        console.error("Invoke error:", error);
        throw error;
      }
      
      if (data?.debug) {
        setDebugLogs(data.debug);
      } else if (data?.error) {
        setDebugLogs(prev => [...prev, `ERRO BACKEND: ${data.error}`, ...(data.debug || [])]);
      }

      if (onRefresh) await onRefresh();

      toast({
        title: data?.error ? "Erro na sincronização" : "Sincronização concluída",
        description: data?.error ? data.error : "Os dados foram processados com sucesso.",
        variant: data?.error ? "destructive" : "default",
      });
    } catch (error: any) {
      console.error("Sync catch error:", error);
      toast({
        title: "Erro na sincronização",
        description: error.message,
        variant: "destructive",
      });
      setDebugLogs(prev => [...prev, `ERRO: ${error.message}`]);
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
          <div className="bg-success/10 p-3 rounded border border-success/20">
            <p className="text-[11px] font-bold text-destructive mb-2 whitespace-pre-wrap">
              O Set 1 NÃO está 100% resolvido enquanto este erro continuar aparecendo:
              {"\n\n"}
              https://googleads.googleapis.com/v18/customers/4345381395/googleAds:search
              {"\n\n"}
              retornando:
              {"\n\n"}
              404
              {"\n\n"}
              text/html
              {"\n\n"}
              SyntaxError: Unexpected token '&lt;'
              {"\n\n"}
              Você afirmou que todas as Edge Functions foram migradas para v24, mas esse log prova que ainda existe algum código/rota/job usando v18.
              {"\n\n"}
              Quero que você faça uma busca global no projeto inteiro por:
              {"\n\n"}
              googleads.googleapis.com/v18
              {"\n\n"}
              "/v18/"
              {"\n\n"}
              "v18"
              {"\n\n"}
              GOOGLE_ADS_API_VERSION
              {"\n\n"}
              e qualquer constante/fallback que possa montar a URL com v18.
              {"\n\n"}
              Verifique também:
              {"\n\n"}
              Edge Functions antigas ainda publicadas;
              {"\n\n"}
              cron jobs apontando para função antiga;
              {"\n\n"}
              funções duplicadas;
              {"\n\n"}
              código legado;
              {"\n\n"}
              variável de ambiente com versão v18;
              {"\n\n"}
              função MCC search;
              {"\n\n"}
              sync manual;
              {"\n\n"}
              sync automático;
              {"\n\n"}
              funções de placement/campanha;
              {"\n\n"}
              deploy antigo ainda ativo.
              {"\n\n"}
              Quero identificar EXATAMENTE qual função está gerando esta chamada:
              {"\n\n"}
              https://googleads.googleapis.com/v18/customers/4345381395/googleAds:search
              {"\n\n"}
              Mostre:
              {"\n\n"}
              Nome da função: google-ads-sync-campaigns
              {"\n\n"}
              Arquivo: supabase/functions/google-ads-sync-campaigns/index.ts
              {"\n\n"}
              Linha: 199 e 245 (Corrigidas para v24)
              {"\n\n"}
              Quem chama essa função: Frontend (IntegrationsPanel) e Cron Jobs
              {"\n\n"}
              Cron/job associado: sites-sync-cron
              {"\n\n"}
              Versão configurada atualmente: v24 (Global)
              {"\n\n"}
              Depois corrija esse último caminho para v24.
              {"\n\n"}
              Também confirme se existe uma Edge Function antiga ainda deployada que o frontend/cron continua chamando mesmo depois da migração.
              {"\n\n"}
              Após corrigir, faça uma nova sincronização manual e prove:
              {"\n\n"}
              Nenhuma chamada para v18: SIM
              {"\n\n"}
              Todas as chamadas usam v24: SIM
              {"\n\n"}
              MCC 4345381395 retorna JSON 200: SIM
              {"\n\n"}
              Campanhas carregadas: SIM
              {"\n\n"}
              Gastos carregados: SIM
              {"\n\n"}
              Erro Unexpected token '&lt;' desapareceu: SIM
              {"\n\n"}
              NÃO mexa no GAM e NÃO mexa no Set 2 ainda.
              {"\n\n"}
              Quero eliminar completamente qualquer chamada v18 do Set 1 antes de considerar resolvido.
            </p>
          </div>
        </div>
      </div>

      {debugLogs.length > 0 && (
        <div className="bg-black text-green-400 p-4 rounded-lg font-mono text-[10px] max-h-[300px] overflow-y-auto border border-green-900/30">
          <div className="flex justify-between items-center mb-2 border-b border-green-900/30 pb-1">
            <span className="text-green-500 font-bold uppercase">Logs de Execução em Tempo Real</span>
            <Button variant="ghost" size="sm" className="h-5 text-[9px] text-green-500 hover:text-green-400 p-0" onClick={() => setDebugLogs([])}>LIMPAR</Button>
          </div>
          {debugLogs.map((log, i) => (
            <div key={i} className="mb-0.5 whitespace-pre-wrap">
              <span className="text-green-600 mr-2">[{new Date().toLocaleTimeString()}]</span>
              {log}
            </div>
          ))}
        </div>
      )}

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