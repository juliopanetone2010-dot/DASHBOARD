# Retenção/Push via Key-Values do GAM — Plano definitivo

Hoje a aba quebra porque a API v1 do GAM não aceita `URL + KEY_VALUES_NAME` juntos. A solução real é parar de depender da dimensão `URL` e usar **key-values customizados** que nós mesmos enviamos no GPT. Assim controlamos exatamente o que vem no relatório.

## 1. Key-values no GPT (site)

No template de tag do site (snippet `googletag`), antes de cada `display()`:

```js
const u = new URL(window.location.href);
const pageUrl = (u.host + u.pathname).toLowerCase().replace(/\/+$/, "");
const params = new URLSearchParams(u.search);

googletag.pubads().setTargeting("page_url", pageUrl);
googletag.pubads().setTargeting("utm_source", params.get("utm_source") || "unknown");
googletag.pubads().setTargeting("utm_campaign", params.get("utm_campaign") || "unknown");
googletag.pubads().setTargeting("site_slug", "<slug do site>");
```

`page_url` salvo só como `host + pathname`, sem `fbclid/gclid/utm/hash`, lowercase, sem trailing slash.

**No GAM Admin** (manual, uma vez por network): criar as keys customizadas `page_url`, `utm_source`, `utm_campaign`, `site_slug` como **Report on values = Include values in reporting** (free-form, report-only). Sem isso o GAM não devolve no relatório.

Multi-site: o snippet é genérico; só `site_slug` muda. Sem hardcode no backend.

## 2. Helper `normalizeUrl()`

Tanto no client (snippet) quanto no edge function (parse). Igual em ambos os lados:
- lowercase
- remove `?query`, `#hash`, `utm_*`, `fbclid`, `gclid`
- remove trailing `/`
- mantém `host + pathname`

## 3. Nova tabela `push_url_revenue`

Migração:
```
site_id, network_code, date, page_url, utm_source, utm_campaign,
revenue_usd, impressions, ecpm, created_at
unique (site_id, date, page_url, utm_source, utm_campaign)
RLS por user_id (via site)
```

## 4. Edge function: novo report do GAM

Em `gam-sync-revenue`, adicionar fluxo `syncPushUrlRevenue()`:

- Dimensões: `DATE`, `CUSTOM_CRITERIA` (ou `CUSTOM_DIMENSION` por key), `DOMAIN_NAME`
- Métricas: `AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE`, `AD_EXCHANGE_LINE_ITEM_LEVEL_IMPRESSIONS`, `AD_EXCHANGE_AVERAGE_ECPM`
- Sem filtro de URL. O agrupamento já vem por combinação de key-values.
- Parse: extrair `page_url`, `utm_source`, `utm_campaign` da string `CUSTOM_CRITERIA` (`page_url=...;utm_source=push;...`).
- Upsert em `push_url_revenue`.
- Fallback `utm_source = "unknown"` quando ausente — **nunca** atribuído a `push`.

Logs de debug: total rows, rows com `utm_source=push`, sample dropped.

## 5. Cron

Adicionar `syncPushUrlRevenue` ao loop atual de retenção em `sync-all-sites-cron`. Mesmo schedule de hoje.

## 6. UI — `RetentionTab.tsx`

- A tabela "URLs de push / retenção" passa a ler **apenas** `push_url_revenue` filtrado por `utm_source=push` e `site_id`.
- Sem chamada ao GAM ao abrir (database-first). Botão "Atualizar" continua invocando o edge function.
- Validação visível: soma `revenue_usd` da tabela = card "Receita Push".
- Cards superiores continuam usando `gam_campaign_source_revenue` (já funcionam).

## 7. Etapas

1. Migração: criar `push_url_revenue` + RLS + índices.
2. Edge function: `normalizeUrl()`, `syncPushUrlRevenue()`, parse CUSTOM_CRITERIA, upsert.
3. Atualizar `RetentionTab` para ler de `push_url_revenue`.
4. Snippet GPT: documento `docs/gpt-snippet.md` com o JS pronto para colar (o usuário aplica no site).
5. Instruções do GAM Admin (criar keys como reportable) — passo manual no painel do GAM.

## 8. O que fica de fora desta entrega

- Ranking de LTV / IA de seleção de URLs / alertas de queda → fase seguinte, depois que os dados começarem a chegar.

## 9. Pré-requisito que depende do usuário

- Colar o snippet no header dos 3 sites (Diario Vagas, Ligado360, Universo dos Cartões).
- No GAM, marcar as 4 keys como **reportable**. Sem isso o report volta vazio mesmo com a tag correta.

Posso aprovar e começar pela migração + edge function + UI; o snippet eu entrego como arquivo de instruções para você aplicar nos sites.
