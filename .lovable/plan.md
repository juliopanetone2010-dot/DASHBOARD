## Objetivo
Melhorar a análise por campanha direto na tabela do dashboard, sem precisar abrir o modal "Reiniciar". Adicionar histórico, idade, padronizar eCPM e mostrar última ação.

## Mudanças

### 1. Novo helper compartilhado de eCPM
Criar `src/lib/campaignEcpm.ts` com `calculateCampaignEcpm(revenueGam, impressionsGam)` retornando `{ ecpm, revenue, impressions, formula }`. Usar em:
- `CampaignsTable.tsx`
- `RestartCampaignButton.tsx` (preview modal)
- Dashboard / Funil

Fonte única: `gam_campaign_source_revenue` (receita + impressões GAM por campanha/dia). Já é o que alimenta `campaignGamMetrics` no dashboard, garantindo consistência.

### 2. Novas colunas na CampaignsTable
- **Início gasto**: primeiro `daily_metrics.date` com `spend > 0` (por `campaign_id`)
- **Idade**: `today - inicio_gasto` em dias
- **Última ação**: mais recente entre `campaign_automation.last_action_date`, `last_cpa_action_date`, `last_scale_date`, e `campaign_restart_flow.last_action_at`

Query em paralelo (React Query) buscando esses agregados por lista de `campaign_ids` visíveis.

### 3. Novo botão "Histórico" separado do "Reiniciar"
Componente `CampaignHistoryButton.tsx` abre Drawer com:
- Seletor 7d / 15d / 30d
- Tabela dia-a-dia: data, custo, receita, lucro, ROI, conversões, impressões (GAM), eCPM (helper), CPA
- Banner destacando: início do gasto, última alteração, entrada no funil, última ação automação
- Dados 100% do banco (`daily_metrics` + `gam_campaign_source_revenue` + `campaign_funnel` + `automation_logs`). Zero chamada Google Ads.

### 4. eCPM com tooltip de debug
Tooltip no valor de eCPM mostrando:
```
Receita GAM: $X
Impressões GAM: Y
eCPM = X / Y * 1000
Fonte: gam_campaign_source_revenue
```

### 5. Padronizar eCPM no modal Reiniciar
`RestartCampaignButton` passa a usar o mesmo helper. Sem mais cálculos divergentes.

## Arquivos
- novo: `src/lib/campaignEcpm.ts`
- novo: `src/components/dashboard/CampaignHistoryButton.tsx`
- editar: `src/components/dashboard/CampaignsTable.tsx` (colunas + botão + tooltip eCPM)
- editar: `src/components/dashboard/RestartCampaignButton.tsx` (usar helper)

## Não escopo
- Sem mudanças de schema (todas as tabelas necessárias já existem).
- Sem novas edge functions (tudo via `supabase.from(...)` no client).
- Sem mexer em Funil/Automation além de leitura.
