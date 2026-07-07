
## Objetivo

Eliminar as divergências entre Dashboard, aba Países e Calendário Financeiro criando **uma única engine de reconciliação** entre Google Ads (custo) e Google Ad Manager (receita), cruzada exclusivamente por `campaign_id` (via `utm_campaign`), sem estimativas nem fallbacks proporcionais.

## Regra de cruzamento (única fonte da verdade)

- Custo: `daily_metrics` (Google Ads) por `campaign_id` + `date`.
- Receita: `gam_placement_revenue` (GAM) por `campaign_id` + `date` (já vem com `utm_campaign` normalizado no `campaign_id`).
- Junção: **INNER JOIN** por `campaign_id` (+ `date` quando aplicável). Nunca ratear por cliques/impressões/custo. Nunca usar `__aggregate__`.
- Receita bruta GAM em USD → aplica rev share fixo de 6,5% → líquida. Converte para BRL apenas para exibição de custo/lucro; receita nativa preservada.
- País da campanha vem de `campaign_country_metrics` (dimensão país já é do próprio Google Ads da campanha). A receita do país = receita GAM da campanha × (share do país **dentro da própria campanha**, calculado por impressões do Google Ads da campanha naquele país). Esse share é o único uso de proporção, e é **interno à campanha**, não distribui receita entre campanhas.

## Arquitetura

Criar módulo compartilhado:

```
supabase/functions/_shared/reconciliation.ts   (Deno, server)
src/lib/reconciliation.ts                       (mirror browser)
```

Exporta:

- `reconcileCampaigns({ siteId, accountIds, from, to, netFactor, fxUsdBrl })`
  → `Map<campaign_id, { cost_brl, revenue_gross_usd, revenue_net_usd, revenue_net_brl, clicks, impressions, conversions, ecpm, roi, profit_brl, matched: boolean, match_rate }>`
- `reconcileByDay(params)` → mesma estrutura agregada por `date`.
- `reconcileByCountry(params)` → agregado por país, usando share intra-campanha por impressões Ads.
- `reconcileTotals(params)` → totais gerais (usado pela Dashboard).

Todas as telas consomem apenas esses métodos. Remover cálculos ad-hoc em:
- `useDashboardData.ts` (totais)
- `CountriesTab.tsx` (substitui `computeCountryPerformanceClient`)
- `FinancialCalendarTab.tsx` (substitui leitura de `daily_financial_snapshots` como fonte primária)
- `generate-daily-snapshot/index.ts` (passa a chamar `reconcileByDay` para gerar snapshot)

## Aba Países

- Loading state: skeleton por linha, com contador `carregando X/Y campanhas`.
- Colunas: País, Campanhas, Custo, Receita, Lucro, ROI, Cliques, Conversões, CPA, CTR, eCPM, Match Rate.
- Match Rate por país = campanhas do país com receita GAM > 0 / campanhas do país.
- Assert em dev: `Σ receita países === totais Dashboard` (mesmo período/filtros). Diferença > 0,5% dispara warning visível ("Divergência X% — clique para depurar").

## Calendário Financeiro

Reescrever `FinancialCalendarTab.tsx` + criar edge function `calendar-regenerate`:

- Botões: **Atualizar mês** e **Regenerar dia**.
- Fluxo "Regenerar mês":
  1. Cliente chama `calendar-regenerate` com `{ site_id, month }`.
  2. Edge function itera dias em série. Para cada dia:
     - força `gam-sync-revenue` (revenue_only, sem cache),
     - força `google-ads-sync-campaigns` (custo do dia),
     - chama `reconcileByDay` para o dia,
     - `upsert` em `daily_financial_snapshots` (idempotente).
  3. Progresso via SSE (`text/event-stream`): envia `{day, index, total}` a cada dia.
- UI mostra progress bar `Dia N/Total` durante o stream. Só re-renderiza a grade **após** `done`. Nenhuma escrita parcial na UI.
- Cache: `staleTime: 0` e `refetchOnMount: 'always'` na query do calendário após regen.
- Validação: ao terminar, roda `reconcileTotals` do mesmo período e compara com `Σ snapshots`. Se diferir, mostra badge de erro e loga.

## Migração / compat

- `daily_financial_snapshots` permanece como cache; passa a ser gerado exclusivamente por `reconcileByDay`.
- `country_performance.ts` (shared) e `src/lib/countryPerformance.ts` viram wrappers finos sobre `reconciliation.ts` até serem removidos.
- Nenhuma alteração de schema.

## Testes

- `src/lib/reconciliation.test.ts`:
  - INNER JOIN não inclui campanha sem GAM.
  - Soma por país == soma por campanha == total.
  - Rev share aplicado exatamente uma vez.
  - Sem receita GAM → receita 0 (nunca estimada).

## Entregáveis

1. `_shared/reconciliation.ts` + mirror `src/lib/reconciliation.ts` + testes.
2. `useDashboardData` refatorado para usar a engine.
3. `CountriesTab` refatorado (remove `countryPerformance.ts` gradualmente).
4. `FinancialCalendarTab` reescrito + edge function `calendar-regenerate` com SSE.
5. `generate-daily-snapshot` passa a chamar a engine.

## Detalhes técnicos

- Paginação Supabase mantida em blocos de 1000 com `range()`.
- `netFactor = 0.935` centralizado em `src/lib/revshare.ts` (já existe) — engine importa dali.
- FX USD→BRL: sempre `exchange_rates` (fallback API), lido uma vez por chamada.
- Serial (não paralelo) na regeneração do calendário para evitar quota do GAM/Ads.
- Sem cache de query no calendário durante regen (`queryClient.removeQueries` antes de iniciar).

Após aprovação, implemento na ordem: engine + testes → Dashboard → Países → Calendário + edge function.
