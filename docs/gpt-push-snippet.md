# GPT key-values para Retenção / Push

Cole este snippet no `<head>` de cada site, **antes** das chamadas `googletag.display()`.
Ele envia ao GAM 4 key-values por requisição de ad slot:

- `page_url` — `host + pathname` normalizado (sem fbclid/gclid/utm/hash, lowercase, sem trailing slash)
- `utm_source` — valor cru da query (`push`, `google`, etc.) ou `unknown`
- `utm_campaign` — valor cru da query ou `unknown`
- `site_slug` — slug fixo do site (trocar por site)

**IMPORTANTE:** o `setTargeting` precisa rodar **ANTES** do primeiro `googletag.display()` / `enableServices()`.
Se a página já chama `enableServices()` em outro snippet, remova lá e deixe só este bloco chamar.

```html
<script>
  window.googletag = window.googletag || { cmd: [] };

  function __normalizeUrl() {
    try {
      var u = new URL(window.location.href);
      return (u.hostname + u.pathname.replace(/\/+$/, "")).toLowerCase();
    } catch (e) { return ""; }
  }

  googletag.cmd.push(function () {
    try {
      var params = new URLSearchParams(window.location.search);
      var pubads = googletag.pubads();
      pubads.setTargeting("page_url", __normalizeUrl());
      pubads.setTargeting("utm_source", (params.get("utm_source") || "unknown").toLowerCase());
      pubads.setTargeting("utm_campaign", (params.get("utm_campaign") || "unknown").toLowerCase());
      // Troque pelo slug do site (ligado360, diariovagas, universocartoes, ...)
      pubads.setTargeting("site_slug", "REPLACE_WITH_SITE_SLUG");
      googletag.enableServices();
    } catch (e) { /* noop */ }
  });
</script>
```

## Como validar no console (DevTools da página)

```js
googletag.pubads().getTargetingKeys();
// => ["page_url","utm_source","utm_campaign","site_slug"]

googletag.pubads().getTargeting("utm_source");
// => ["push"]  (em URLs com ?utm_source=push)

googletag.pubads().getTargeting("page_url");
// => ["seusite.com/algum/path"]
```

Se vier `[]`, o snippet **não está rodando antes** do `enableServices()` — corrija a ordem.

## Pré-requisito no GAM (uma vez por network)

Em **Admin → Inventory → Key-values**, criar (ou editar) as 4 chaves:

| Key            | Type      | Report on values             |
| -------------- | --------- | ---------------------------- |
| `page_url`     | Free-form | Include values in reporting  |
| `utm_source`   | Free-form | Include values in reporting  |
| `utm_campaign` | Free-form | Include values in reporting  |
| `site_slug`    | Free-form | Include values in reporting  |

Sem marcar **Include values in reporting**, o GAM não devolve os valores na API de reports e a tabela de URLs continuará vazia.

## Como validar

1. Aplicar o snippet em produção (ou staging com tráfego real).
2. Esperar 1–2 horas para o GAM consolidar.
3. No dashboard, ir em **Retenção / Push** → **Atualizar**.
4. A tabela "URLs de push / retenção" deve listar as páginas com `utm_source=push`, e a soma de `Receita` deve bater com o card **Receita push (USD)**.
