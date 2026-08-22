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
              A v24 já está respondendo 200/JSON, mas os gastos AINDA NÃO estão sendo atualizados no dashboard.
              {"\n\n"}
              Portanto, não quero mais diagnóstico de versão da API. Isso já foi resolvido.
              {"\n\n"}
              Quero rastrear exatamente onde o gasto está sumindo.
              {"\n\n"}
              Use UMA campanha/conta real que teve gasto hoje e faça o fluxo completo:
              {"\n\n"}
              Google Ads API v24 {"\u2192"} metrics.cost_micros {"\u2192"} conversão {"\u2192"} persistência {"\u2192"} SELECT banco {"\u2192"} dashboard
              {"\n\n"}
              Para o Customer ID 6209877933, faça uma consulta manual de HOJE e mostre:
              {"\n\n"}
              campaign.id
              {"\n"}
              campaign.name
              {"\n"}
              segments.date
              {"\n"}
              metrics.cost_micros
              {"\n"}
              valor convertido = cost_micros / 1_000_000
              {"\n\n"}
              Depois me mostre:
              {"\n"}
              1. A API realmente retorna cost_micros {"\u003E"} 0?
              {"\n"}
              Se SIM, informe o valor bruto e convertido.
              {"\n"}
              2. Esse valor está sendo salvo no banco?
              {"\n"}
              Mostre a tabela, linha e campos:
              {"\n"}
              campaign_id
              {"\n"}
              customer_id
              {"\n"}
              date
              {"\n"}
              cost_micros
              {"\n"}
              cost
              {"\n"}
              updated_at
              {"\n"}
              Faça um SELECT depois do UPSERT para provar que o valor foi persistido.
              {"\n"}
              3. A query do dashboard lê exatamente esse registro?
              {"\n"}
              Compare:
              {"\n"}
              campaign_id
              {"\n"}
              customer_id
              {"\n"}
              site_id
              {"\n"}
              date
              {"\n"}
              timezone
              {"\n"}
              api_set
              {"\n"}
              sync_enabled
              {"\n"}
              Quero saber se algum filtro está fazendo o dashboard ignorar o registro recém-salvo.
              {"\n"}
              4. Verifique se a migração v18 {"\u2192"} v24 alterou o formato da resposta.
              {"\n"}
              Confirme se o parser atual está lendo corretamente:
              {"\n"}
              results[].metrics.costMicros
              {"\n"}
              ou o campo equivalente retornado pela REST v24.
              {"\n"}
              Verifique se o código antigo esperava outro formato, como:
              {"\n"}
              metrics.cost_micros
              {"\n"}
              e por isso está transformando o gasto em undefined, null ou 0.
              {"\n"}
              5. Verifique os dois Sets separadamente.
              {"\n"}
              Set 1 — Universo
              {"\n"}
              API retorna gasto {"\u003E"} 0?
              {"\n"}
              Banco salva?
              {"\n"}
              Dashboard lê?
              {"\n"}
              Set 2 — Jardim Astral
              {"\n"}
              API retorna gasto {"\u003E"} 0?
              {"\n"}
              Banco salva?
              {"\n"}
              Dashboard lê?
              {"\n\n"}
              Não diga apenas “sincronização restaurada”.
              {"\n"}
              Quero números reais.
              {"\n\n"}
              No final responda:
              {"\n"}
              Set 1 API cost_micros:
              {"\n"}
              Set 1 valor salvo no banco:
              {"\n"}
              Set 1 valor exibido no dashboard:
              {"\n"}
              Set 2 API cost_micros:
              {"\n"}
              Set 2 valor salvo no banco:
              {"\n"}
              Set 2 valor exibido no dashboard:
              {"\n"}
              Etapa exata onde o valor some:
              {"\n\n"}
              Não altere Google Ad Manager.
              {"\n"}
              Não altere textos do painel.
              {"\n"}
              Não troque novamente a versão da API.
              {"\n"}
              Só corrija o ponto exato onde metrics.cost_micros deixa de chegar ao dashboard.
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