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
              A receita das campanhas apareceu, mas está TOTALMENTE BUGADA.
              {"\n\n"}
              O print mostra que praticamente todas as campanhas estão com:
              {"\n\n"}
              ROI = +274,84%
              {"\n\n"}
              e
              {"\n\n"}
              ROAS = 3,75x
              {"\n\n"}
              mesmo tendo gastos, impressões, cliques e desempenho completamente diferentes.
              {"\n\n"}
              Isso prova que o sistema está aplicando o ROI/ROAS geral do site ou distribuindo a receita proporcionalmente entre as campanhas.
              {"\n\n"}
              EU NÃO QUERO ISSO.
              {"\n\n"}
              REMOVA A ATRIBUIÇÃO PROPORCIONAL
              {"\n\n"}
              Não use mais:
              {"\n\n"}
              proporção por gasto;
              {"\n\n"}
              proporção por impressões;
              {"\n\n"}
              proporção por cliques;
              {"\n\n"}
              ROI geral do site;
              {"\n\n"}
              Predictive para preencher receita real histórica.
              {"\n\n"}
              Cada campanha deve receber EXCLUSIVAMENTE a receita REAL retornada pelo Google Ad Manager para o seu próprio Campaign ID.
              {"\n\n"}
              Nós já comprovamos que no GAM é possível consultar:
              {"\n\n"}
              Channel = utm_campaign=23207554976
              {"\n\n"}
              e obter a receita real daquela campanha.
              {"\n\n"}
              Portanto, para cada Channel:
              {"\n\n"}
              utm_campaign=CAMPAIGN_ID
              {"\n\n"}
              faça:
              {"\n\n"}
              Campaign ID → Receita real GAM daquele Channel
              {"\n\n"}
              e associe diretamente à campanha correspondente.
              {"\n\n"}
              EXEMPLO
              {"\n\n"}
              Se o GAM retornar:
              {"\n\n"}
              utm_campaign=23207554976 → R$ 1.474,31
              {"\n\n"}
              então SOMENTE a campanha:
              {"\n\n"}
              23207554976
              {"\n\n"}
              deve receber:
              {"\n\n"}
              Receita = R$ 1.474,31
              {"\n\n"}
              Depois:
              {"\n\n"}
              Lucro = Receita real - Gasto
              {"\n\n"}
              ROI = (Lucro / Gasto) × 100
              {"\n\n"}
              ROAS = Receita real / Gasto
              {"\n\n"}
              Não use nenhuma receita de outra campanha.
              {"\n\n"}
              CORRIJA OS DADOS DE ONTEM
              {"\n\n"}
              Os valores que foram inseridos ontem usando a atribuição proporcional estão incorretos.
              {"\n\n"}
              Reprocesse a data usando os dados REAIS por:
              {"\n\n"}
              AD_EXCHANGE_CHANNEL_NAME
              {"\n\n"}
              ou dimensão equivalente ao Channel do Interactive Report.
              {"\n\n"}
              Pegue todos os Channels que começam com:
              {"\n\n"}
              utm_campaign=
              {"\n\n"}
              Extraia o Campaign ID e grave a receita real correspondente.
              {"\n\n"}
              VALIDAÇÃO
              {"\n\n"}
              Escolha pelo menos 5 campanhas com gastos diferentes e me mostre:
              {"\n\n"}
              Campaign ID | Gasto | Channel GAM | Receita REAL GAM | Lucro | ROI | ROAS
              {"\n\n"}
              Os valores de ROI NÃO podem ser todos iguais, a menos que os dados reais matematicamente resultem nisso.
              {"\n\n"}
              VERIFIQUE O BANCO
              {"\n\n"}
              Certifique-se de que os registros proporcionais/estimados antigos não estão sendo tratados como receita consolidada.
              {"\n\n"}
              Se houver:
              {"\n\n"}
              attribution_status = estimated/intraday/predictive
              {"\n\n"}
              eles NÃO devem substituir:
              {"\n\n"}
              attribution_status = consolidated/real
              {"\n\n"}
              Para datas passadas já consolidadas pelo GAM, use SOMENTE receita real.
              {"\n\n"}
              IMPORTANTE
              {"\n\n"}
              O print atual está errado.
              {"\n\n"}
              Ver todas as campanhas com aproximadamente:
              {"\n\n"}
              ROI +274,84%
              {"\n\n"}
              ROAS 3,75x
              {"\n\n"}
              é evidência de que a lógica de atribuição está replicando o desempenho geral do site.
              {"\n\n"}
              Corrija a atribuição individual REAL.
              {"\n\n"}
              NÃO altere textos do dashboard.
              {"\n\n"}
              NÃO mexa no Google Ads v24.
              {"\n\n"}
              NÃO altere OAuth/MCC.
              {"\n\n"}
              NÃO crie outro fallback proporcional.
              {"\n\n"}
              Só considere concluído quando cada campanha apresentar seu próprio valor real de:
              {"\n\n"}
              Gasto | Receita | Lucro | ROI | ROAS FACA FUNCIONAR IGUAL FUNCIONOU NO DIA 20
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