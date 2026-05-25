## Diagnóstico

A engine canônica que você descreveu **já existe** e está funcionando:

- `supabase/functions/_shared/canonical_placement.ts` — `parseCanonicalPlacement()`, `normalizePlacement()`, `reconcileRow()` com hierarquia exact_utm_placement (100) → campaign_placement (95) → normalized_url (70) → inferred (40).
- Tabela `placement_revenue_reconciled` com todos os campos da spec (canonical_key, reconciliation_method, confidence, broken_tracking, source_row, aggregate_allocated_revenue_usd, etc).
- Edge function `rebuild-canonical-placement-engine` reprocessa tudo e popula a tabela.
- `AttributionAuditTab` já tem botão "Rebuild canonical engine".
- **100% das 7.905 linhas reconciliadas dos últimos 2 dias estão como `exact_utm_placement`.** A engine acerta.

## Por que o dashboard mostra errado

O **consumidor** ainda lê das tabelas brutas, não da reconciliada:

| Arquivo | Tabela lida hoje | Deveria ler |
|---|---|---|
| `src/pages/Index.tsx` linha 93 (extraRevQuery push/other) | `gam_campaign_source_revenue` | `placement_revenue_reconciled` |
| `src/pages/Index.tsx` linha 237 (siteShareQuery) | `gam_placement_revenue` | `placement_revenue_reconciled` |
| `src/components/dashboard/PlacementsTab.tsx` linha 124 (fetchAllGamPlacementRevenue) | `gam_placement_revenue` | `placement_revenue_reconciled` |

Isso explica receita zero/errada em campanhas: a UI ignora o que a engine canônica já reconciliou.

## Mudanças

### 1. Migrar leituras para a tabela reconciliada
- `Index.tsx`: trocar `gam_placement_revenue`/`gam_campaign_source_revenue` por `placement_revenue_reconciled` filtrando `reconciliation_method = 'exact_utm_placement'` (com fallback ao bruto só pra `utm_source != google` push/wpp/direct, que não entra na engine canônica).
- `PlacementsTab.tsx`: `fetchAllGamPlacementRevenue` passa a ler `placement_revenue_reconciled` por `campaign_id`, retornando `placement`, `normalized_placement`, `revenue_usd`, `impressions`, `clicks`, `ecpm`, `reconciliation_method`, `confidence`, `broken_tracking`.

### 2. Badges na aba Placements
Em cada linha de placement adicionar badge baseado no row:
- `VERIFIED` (verde) — `reconciliation_method = exact_utm_placement` e `confidence = 100`
- `INFERRED` (amarelo) — `confidence < 95`
- `BROKEN` (vermelho) — `broken_tracking = true`
- `LEAK` (cinza) — placement existe em `ads_placements` mas sem linha em `placement_revenue_reconciled` (cliques sem revenue casada)

### 3. Trava de segurança no cleanup
Em `GlobalPlacementCleanup`/`PlacementsTab` qualquer botão de "excluir placement" só habilita se `confidence >= 95` E `reconciliation_method = 'exact_utm_placement'`. Caso contrário, botão desabilitado com tooltip "tracking não verificado".

### 4. Auto-rebuild
Adicionar cron (pg_cron) chamando `rebuild-canonical-placement-engine` a cada 30 min para os últimos 3 dias, garantindo que `placement_revenue_reconciled` esteja sempre fresca sem depender do botão manual.

### 5. Pequeno hardening do normalizador
Atualizar `normalizePlacement()` em `_shared/canonical_placement.ts` para também tratar:
- decodeURIComponent
- remover anchors (`#...`)
- remover slashes duplicados
- remover trailing slash quando houver path (mantendo só host hoje já cobre, mas adicionar para placements com path)

## Arquivos tocados

- `supabase/functions/_shared/canonical_placement.ts` — hardening do normalize
- `src/pages/Index.tsx` — trocar 2 queries de receita
- `src/components/dashboard/PlacementsTab.tsx` — trocar fonte + adicionar badges + trava de exclusão
- `src/components/dashboard/AttributionAuditTab.tsx` — adicionar métrica "VERIFIED %" no header
- 1 migration nova: cron 30min chamando `rebuild-canonical-placement-engine`

Nenhuma tabela nova, nenhuma edge function nova. A engine já existe — só estou plugando a UI nela.

## Resultado esperado

- Receita por campanha = soma de `placement_revenue_reconciled` onde `campaign_id = X` e `exact_utm_placement` → bate 1:1 com GAM por `utm_placement`.
- Campanhas como SENAI/JOVEM APRENDIZ continuam $0 só se realmente não tiverem cliques chegando em página monetizada — o que é a verdade, não bug.
- Nenhum placement marcado "ruim" se confidence < 95.