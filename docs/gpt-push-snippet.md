# GPT key-values para Retenção / Push

Cole este snippet no `<head>` de cada site, **antes** das chamadas `googletag.display()`.
Ele envia ao GAM 4 key-values por requisição de ad slot:

- `page_url` — `host + pathname` normalizado (sem fbclid/gclid/utm/hash, lowercase, sem trailing slash)
- `utm_source` — valor cru da query (`push`, `google`, etc.) ou `unknown`
- `utm_campaign` — valor cru da query ou `unknown`
- `site_slug` — slug fixo do site (trocar por site)

```html
<script>
  window.googletag = window.googletag || { cmd: [] };
  googletag.cmd.push(function () {
    try {
      var u = new URL(window.location.href);
      var pageUrl = (u.host + u.pathname).toLowerCase().replace(/\/+$/, "");
      var params = new URLSearchParams(u.search);
      var pubads = googletag.pubads();
      pubads.setTargeting("page_url", pageUrl);
      pubads.setTargeting("utm_source", (params.get("utm_source") || "unknown").toLowerCase());
      pubads.setTargeting("utm_campaign", (params.get("utm_campaign") || "unknown").toLowerCase());
      // Troque pelo slug do site (ligado360, diariovagas, universocartoes, ...)
      pubads.setTargeting("site_slug", "REPLACE_WITH_SITE_SLUG");
    } catch (e) { /* noop */ }
  });
</script>
```

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
