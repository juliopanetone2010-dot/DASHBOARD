# Match Rate — Validação 17/06 + Tela de Debug

## Diagnóstico do dia 17/06/2026 (campanha 23842320470)

Dado já consultado em `gam_campaign_source_revenue`:

| Data       | Impressões (matched) | Total requests | match_rate_pct (banco) |
|------------|----------------------|----------------|------------------------|
| 2026-06-17 | 219                  | 233            | **94,09 %**            |
| 2026-06-16 | 715                  | 1.040          | 68,72 %                |
| 2026-06-15 | 194                  | 287            | 67,70 %                |

O banco **bate exatamente com o GAM** (no print, 16/jun = 68,72 % é o mesmo valor armazenado). Portanto o dado canônico está correto.

## Onde está o problema do frontend

Em `src/pages/Index.tsx` (linhas 365–438), a agregação no intervalo atualmente faz:

- Quando a linha tem `match_rate_pct`, recalcula `exactRequests = impressions / (rate/100)`.
- Quando a linha tem só `total_requests`, usa direto.
- O resultado por campanha é `Σ exactImpressions / Σ exactRequests`.

Riscos identificados:
1. **Mistura de fontes**: para campanhas com dias antigos (maio) sem `total_requests` nem `match_rate_pct`, essas impressões são descartadas da conta — correto, mas confunde o usuário porque o card "Impressões" do match rate fica menor que o card "Impressões GAM".
2. **Arredondamento**: `Math.round(v.exactRequests)` no `totalRequests` exibido pode divergir 1 unidade do GAM em alguns dias.
3. **Período/timezone**: o `range.from`/`range.to` é em data local (BRT). Se o usuário olha "Hoje" (17/jun) mas o GAM já consolidou 17/jun com fuso da rede, o número diário pode ainda estar em movimento.
4. **Cache**: `staleTime: 30s` + `refetchInterval: 2min` — quando o sync GAM acabou de rodar, o frontend pode mostrar valor stale por até 2 min.

## O que vou implementar

### 1. Corrigir a exibição no dashboard
- **Usar `match_rate_pct` canônico do banco** quando existir, em vez de recalcular via divisão. Para multi-dia: média ponderada por `impressions` (`Σ (rate_i · imp_i) / Σ imp_i`), idêntica ao que o GAM faz.
- Quando o range é 1 único dia e há `match_rate_pct` armazenado → mostrar **exatamente** esse valor (sem cálculo derivado).
- Reduzir `staleTime` para 10s e adicionar botão de "Recarregar" no tooltip.

### 2. Modal "Debug Match Rate" (novo)
Acionado por um clique na célula "Taxa Corresp." da `CampaignsTable`. Conteúdo:

```
Campanha: 23842320470 · Período: 15/jun – 17/jun

Por dia:
┌────────────┬─────────┬─────────┬──────────┬─────────────┐
│ Data       │ Matched │ Total   │ Rate     │ Fonte       │
├────────────┼─────────┼─────────┼──────────┼─────────────┤
│ 2026-06-17 │ 219     │ 233     │ 94,09 %  │ ad_requests │
│ 2026-06-16 │ 715     │ 1.040   │ 68,72 %  │ ad_requests │
│ 2026-06-15 │ 194     │ 287     │ 67,70 %  │ ad_requests │
└────────────┴─────────┴─────────┴──────────┴─────────────┘

Consolidado período:
  Matched (banco):     1.128
  Total (banco):       1.560
  Match Rate (banco):  72,31 %   ← Σ matched / Σ total
  Match Rate ponderado: 72,31 %  ← Σ(rate·imp)/Σ imp

  Match Rate no dashboard: 72,31 %   ✅ OK
  (ou ❌ DIVERGÊNCIA se diferente, com diff numérico)

Última sincronização GAM: 17/jun 09:46
[ Botão: Re-sincronizar este período ]
```

Fonte dos dados: `gam_campaign_source_revenue` filtrado por `campaign_id` + `utm_source='google'` + intervalo.

### 3. Arquivos afetados
- `src/pages/Index.tsx` — trocar fórmula de match rate por média ponderada usando `match_rate_pct`.
- `src/components/dashboard/CampaignsTable.tsx` — célula da taxa vira clicável (abre modal).
- `src/components/dashboard/MatchRateDebugDialog.tsx` *(novo)* — modal de debug.

Sem alterações de schema, sem migrações.

## Critérios de aceite
- Para a campanha 23842320470 no dia 17/jun isolado: dashboard mostra **94,09 %**, idêntico ao GAM e ao banco.
- Para o intervalo 15–17/jun: dashboard mostra o mesmo valor que o GAM mostraria para o mesmo intervalo (média ponderada por impressões).
- Modal de debug abre clicando na célula e mostra a tabela diária + comparativo banco × dashboard, com indicador ✅/❌.
