# Diagnóstico de Atribuição por Campanha

## Problema Identificado
Campanhas com gasto registrado no Google Ads aparecem com receita $0.00 na dashboard, impossibilitando a análise de ROI individual.

## Auditoria de Dados (2026-08-20)
Para o dia 20/08 (ontem), os dados consolidados no banco mostram que a atribuição **FUNCIONA** para algumas campanhas, mas falha para outras.

| Campanha | ID | Gasto (Ads) | Receita (GAM) | Status |
| :--- | :--- | :--- | :--- | :--- |
| [ROBLOX] [MÉXICO] | 23207554976 | R$ 908,41 | $ 305.75 | ✅ Atribuída |
| [ROBLOX] [Alemanha] + | 23021142139 | R$ 181,34 | $ 65.25 | ✅ Atribuída |
| [MONITORAR WHATSAPP] | 23309079322 | R$ 303,12 | $ 91.17 | ✅ Atribuída |
| Outras do print | - | > R$ 0,00 | $ 0.00 | ❌ Falhando |

## Causas Prováveis
1. **Consolidação GAM (Hoje):** Para os dados de hoje (21/08), o GAM ainda não devolveu os relatórios de `KEY_VALUES_NAME` (utm_campaign), o que é normal para o período da manhã/tarde.
2. **Inconsistência de UTMs:** Campanhas que gastaram ontem e estão zeradas provavelmente não estão enviando o `utm_campaign={campaignid}` corretamente ou o valor capturado pelo GAM não casa com o ID numérico.
3. **Limite de API (Sync State):** O log de `sync_state` para `gam-sync-revenue` não está atualizando corretamente, indicando que a tarefa de background pode estar morrendo ou sendo suprimida por quota.

## Plano de Ação
1. **Reforçar a Atribuição:** Alterar a Edge Function para tentar extrair o ID da campanha também da `URL_NAME` como fallback definitivo quando o `KEY_VALUES_NAME` falhar.
2. **Correção de Join:** Garantir que a dashboard não exiba "0" quando os dados ainda estão sendo processados (Readiness Signal).
3. **Reprocessamento:** Disparar um sync forçado para os dias 20 e 21 para garantir que nada ficou para trás.
