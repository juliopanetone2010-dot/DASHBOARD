## Refatorar engine da aba Retenção / Push

Hoje a aba usa `gam_campaign_source_revenue` agregada por campanha, o que mistura aggregate rows e não permite ver URL exata. Vou criar uma engine isolada que puxa do GAM apenas linhas com `utm_source=push`, por URL exata, e bate com o relatório manual.

### 1. Schema novo — `push_retention_revenue`

Tabela isolada (não reaproveita `gam_url_revenue` que mistura tudo):

```
id, site_id, user_id, date, url, normalized_url,
utm_source, revenue_usd, impressions, ecpm,
source, raw_gam_row (jsonb), created_at, updated_at
```

Constraint: `UNIQUE(site_id, date, normalized_url)` para idempotência.
RLS: dono + `can_access_site`. GRANTs explícitos.

Tabela auxiliar `unattributed_push_revenue` para aggregate rows (`__aggregate__`, URLs vazias):
```
id, site_id, date, revenue_usd, impressions, reason, raw_gam_row
```

### 2. Edge function `gam-sync-push-retention`

Nova função dedicada, não toca em `gam-sync-revenue` (que continua servindo o dashboard).

Fluxo:
1. RBAC: `requireUser` + `requireSiteAccess`
2. Query GAM Network Report: dimensões `[AD_UNIT_NAME, CUSTOM_CRITERIA, URL]` com filtro `CUSTOM_TARGETING_VALUE_ID = utm_source=push` (ou via custom field do site)
3. Para cada linha:
   - Pular se `utm_source !== 'push'` (match exato, sem fuzzy)
   - Se URL é aggregate (`__aggregate__`, vazia, `(not set)`) → `unattributed_push_revenue`
   - Senão: `normalizePushUrl()` e upsert em `push_retention_revenue`
4. `ecpm = (revenue_usd / impressions) * 1000` calculado no insert (nunca estimado)
5. Retornar relatório de debug: `{matched, ignored, aggregate, duplicates, anomalies}`

### 3. Helper `normalizePushUrl()`

Em `supabase/functions/_shared/normalize_url.ts` (reusável front+back via cópia em `src/lib/`):

```ts
- decodeURIComponent
- lowercase
- remove protocol (http://, https://)
- remove www.
- remove trailing slash
- remove query params (manter slug puro)
- collapse múltiplos //
```

### 4. UI — refatorar `RetentionTab.tsx`

Substituir query atual:
- Card "Receita Push Total": `SUM(revenue_usd) WHERE utm_source='push'` da nova tabela
- Card "Não atribuído" (aggregate): da `unattributed_push_revenue` — mostrado separadamente
- Tabela inferior: URL real | Receita | Impressões | eCPM (calculado) | utm | data
- Botão "Sincronizar Push" chama `gam-sync-push-retention`
- Badge `VERIFIED` por linha se `raw_gam_row` confere com os campos calculados
- Painel debug colapsável: matched / ignored / aggregate / duplicates / anomalies (linhas com eCPM > 1000 ou < 0.01)

### 5. Pontos técnicos

- A tabela atual `gam_campaign_source_revenue` é mantida (alimenta o dashboard principal e as outras abas)
- Migração não destrói nada — apenas adiciona 2 tabelas
- Sync inicial: usuário roda manualmente ao abrir a aba (sem cron por enquanto)
- Match URL: case-insensitive, mas comparação por `normalized_url` exato (sem `LIKE %`)
- Aggregate contamination = 0 garantido porque agregadas vão pra outra tabela física

### Arquivos

- `supabase/migrations/<ts>_push_retention.sql` (novo)
- `supabase/functions/_shared/normalize_url.ts` (novo)
- `supabase/functions/gam-sync-push-retention/index.ts` (novo)
- `src/lib/normalizePushUrl.ts` (novo, espelho do shared)
- `src/components/dashboard/RetentionTab.tsx` (refatorado)

Quer que eu prossiga com a migração + edge function + UI?
