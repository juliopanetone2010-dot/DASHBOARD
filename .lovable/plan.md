# Plano: Corrigir Visibilidade dos Gastos do Google Ads

O usuário relatou que os gastos do Google Ads não estão aparecendo no dashboard ("Cade os gastos do google ads? nao estou entendendo"). Após análise, identifiquei que os dados de gastos existem no banco de dados (`daily_metrics`), mas o dashboard está exibindo R$ 0,00. O problema principal é que as contas do Google Ads e os Sites (GAM) não estão corretamente vinculados no ambiente atual, ou os filtros aplicados estão restringindo a visualização.

## Mudanças

### Backend (Edge Functions)
- Não são necessárias mudanças imediatas nas funções de sincronização, pois os dados estão sendo populados.

### Frontend
- **IntegrationsPanel**: Melhorar o feedback visual quando não há mapeamento entre contas Ads e sites.
- **AccountSiteMappingPanel**: Facilitar a identificação de contas que possuem gastos mas não estão vinculadas a nenhum site.
- **Dashboard Data Hook (`useDashboardData.ts`)**: Adicionar logs de depuração em desenvolvimento para rastrear por que os gastos estão sendo filtrados (isolamento por site).
- **Dashboard Principal (`Index.tsx`)**: Ajustar a lógica de exibição para alertar o usuário se ele estiver visualizando um site que não tem nenhuma conta de Ads vinculada.

## Detalhes Técnicos
- Verificação da lógica de `effectiveAccountIds` em `src/hooks/useDashboardData.ts`. Se um site for selecionado, mas não houver `account_site_links` para ele, o sistema filtra por um UUID vazio, resultando em zero gastos.
- Ajuste no `MetricCard` de gastos para mostrar um aviso se houver contas desconectadas ou sem vínculo.

## Próximos Passos
1. Corrigir o estado inicial do mapeamento para garantir que o usuário veja o que precisa vincular.
2. Adicionar alertas de configuração pendente no dashboard.
