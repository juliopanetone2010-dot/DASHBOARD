
# Arquitetura Database-First (estilo GAM/AdSense)

Objetivo: tela abre **instantânea** lendo do banco. APIs externas (Google Ads/GAM) rodam **só em background** via cron. UI **nunca** espera por elas.

---

## Princípio central

```text
[ Google Ads API ]──┐
                    ├──► [ CRON background ] ──► [ Postgres (banco) ] ──► [ React (UI instantânea) ]
[ GAM API ]─────────┘                                  ▲
                                                       │
                              [ Botão "Atualizar" manual (opcional) ]
```

Regras:
1. Frontend **só lê** do banco. Nunca chama edge function de sync no carregamento.
2. Sync acontece **só** via cron OU clique manual no botão "Atualizar".
3. Trocar filtro/site/data = `data.refresh()` (leitura). **Não** dispara sync.
4. Botão "Atualizar": se último sync < 30min → mostra toast "dados recentes" e nem chama. Se > 30min → dispara sync em background, UI continua respondendo.
5. Header sempre mostra `Última atualização: 10:35` por fonte (Google Ads / GAM).

---

## Etapas

### 1. Limpar gatilhos de sync no frontend
- `src/pages/Index.tsx`: remover `syncDashboardData` do `handleFilterChange`. Filtro só chama `data.refresh()`.
- Carregamento inicial **nunca** dispara sync. Se banco vazio para o range, mostra estado "sem dados — clique em Atualizar".
- Banner "Coletando dados…" só aparece quando o usuário **clicou** em Atualizar e o sync está em curso.
- Mesma regra aplicada às abas: Calendário, Migração, Funil, Países, Placements, Criativos, Retenção.

### 2. Botão "Atualizar" inteligente (cache 30min)
- Lê `rules_config.last_*_sync_at` (já existem alguns campos: `automation_last_run_at`, etc).
- Se `now - lastSync < 30min`: toast "Dados recentes (sync há Xmin)". Não chama nada.
- Se ≥ 30min: dispara sync **fire-and-forget** (não dá `await`). UI segue navegável. Quando termina, invalida React Query e atualiza silenciosamente.
- Indicador de "sync em andamento" só no header (spinner pequeno + "sincronizando…"), nunca cobrindo a tela.

### 3. Tabela de controle de sync
Nova tabela `sync_state` para registrar última sincronização por (site/conta/fonte):

```text
sync_state
├── id, user_id
├── source (google_ads | gam | placements | countries | creatives | funnel)
├── google_account_id (nullable)
├── site_id (nullable)
├── last_started_at, last_finished_at
├── last_status (ok | error | running)
├── last_error (text)
└── rows_synced (int)
```
RLS: `auth.uid() = user_id`.

Cada edge function de sync grava aqui ao começar e ao terminar. Frontend lê pra mostrar "Última atualização: 10:35 ✓" por fonte.

### 4. Crons em background (pg_cron)
Um cron por fonte, intervalado pra não saturar. Cada um chama a edge function existente para **todos** os usuários/contas:

| Cron | Frequência | Função |
|---|---|---|
| Google Ads campanhas + métricas | 30 min | `google-ads-sync-campaigns` |
| GAM revenue | 1 h | `gam-sync-revenue` |
| Placements | 2 h | `google-ads-sync-placements` |
| Countries | 2 h | `google-ads-sync-countries` |
| Creatives | 4 h | `google-ads-sync-creatives` |
| FX rates | 6 h | `fx-sync` |

(Os crons de automação/funil/geo-cleanup já existem e ficam como estão.)

### 5. Materialized views para dashboards pesados
Views que agregam por dia/site/conta — refresh diário (ou a cada 1h via cron). Frontend lê da view, não recalcula no client:

- `dashboard_overview_daily` (spend, revenue_usd, revenue_brl, profit, roi, roas, clicks, conversions) por `user_id, site_id, date`
- `campaign_summary_daily` por `user_id, campaign_id, date`
- `placement_summary_daily` por `user_id, campaign_id, placement, date`
- `country_summary_daily` por `user_id, campaign_id, country_code, date`
- `creative_summary_daily` por `user_id, campaign_id, ad_id, date`

`REFRESH MATERIALIZED VIEW CONCURRENTLY` via cron a cada 30min. Índices em `(user_id, site_id, date)`.

### 6. React Query — stale-while-revalidate
Configurar globalmente:
- `staleTime: 5 * 60 * 1000` (5min — não refaz fetch)
- `gcTime: 30 * 60 * 1000`
- `refetchOnWindowFocus: false`
- `refetchOnMount: false` (já tem cache → mostra cache, não bloqueia)
- `placeholderData: keepPreviousData` (troca de filtro mostra dados antigos enquanto novo chega)

Resultado: navegar entre abas = instantâneo. Trocar filtro = mostra dados antigos por 200ms até o novo chegar do banco.

### 7. Aplicação por aba
Remover qualquer chamada a `*-sync-*` no `useEffect`/mount de:
- `MigrationTab`, `PlacementsTab`, `CountriesTab`, `CreativesTab`, `FinancialCalendarTab`, `RetentionTab`, `PlacementFunnelTab`, `SmartFunnelPanel`.

Cada uma passa a ler **só** das tabelas/views correspondentes. Se precisarem de "atualizar agora", têm botão local que segue mesma regra (cache 30min + fire-and-forget).

### 8. Header global de status
Componente `SyncStatusBar` no topo da Index:
```text
✓ Google Ads: 10:31  ✓ GAM: 10:15  ✓ Placements: 09:00   [Atualizar tudo]
```
Cores: verde se < 1h, amarelo 1-6h, vermelho > 6h ou erro.

---

## Detalhes técnicos

**Migrations necessárias:**
- `CREATE TABLE sync_state (...)` + RLS
- `CREATE MATERIALIZED VIEW dashboard_overview_daily AS ...` (+ outras 4)
- Índices: `CREATE UNIQUE INDEX ON dashboard_overview_daily (user_id, site_id, date)` (necessário para `REFRESH CONCURRENTLY`)
- Habilitar `pg_cron` e `pg_net` se ainda não.

**Crons (via supabase--insert, não migration — contém keys):**
- 6 jobs novos no `cron.schedule(...)` chamando as edge functions com `pg_net.http_post`.
- 1 job extra chamando `REFRESH MATERIALIZED VIEW CONCURRENTLY` a cada 30min.

**Edge functions:**
- Adicionar em cada sync function: `INSERT INTO sync_state` no início (status=running), `UPDATE` no fim (status=ok/error + rows_synced).
- Não criar funções novas — só instrumentar as existentes.

**Frontend:**
- `src/pages/Index.tsx`: remover sync do `handleFilterChange` e do mount.
- `src/App.tsx`: configurar QueryClient com defaults stale-while-revalidate.
- Novo `src/components/dashboard/SyncStatusBar.tsx`.
- Novo hook `src/hooks/useSyncState.ts` lendo `sync_state` com Realtime opcional.
- `src/hooks/useDashboardData.ts`: trocar fontes por views materializadas onde possível.

**Compatibilidade:**
- Tabelas atuais (`daily_metrics`, `gam_placement_revenue` etc) ficam intactas. Views materializadas leem delas. Zero breaking change.

---

## Entregáveis (em ordem)

1. Migration: `sync_state` + materialized views + índices.
2. Insert: 7 cron jobs (`pg_cron`).
3. Edge functions: instrumentar com `sync_state`.
4. Frontend: remover syncs automáticos + QueryClient defaults + `SyncStatusBar` + botão Atualizar inteligente.
5. Frontend por aba: remover syncs em mount de Migração/Funil/Países/Placements/Criativos/Calendário/Retenção.
6. QA visual de cada aba: abrir e confirmar carregamento instantâneo.

---

## Confirmação

Esse é um trabalho grande (touches ~15 arquivos, 1 migration grande, 7 crons, 6 edge functions). Vou executar em uma única passada se você aprovar este plano. Posso começar?
