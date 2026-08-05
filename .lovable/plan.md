# Plano: Suporte a Múltiplas Credenciais Google Ads (MCCs)

## Contexto

A maioria das contas Ads foram suspensas. Uma conta ainda permanece na MCC antiga. Uma nova MCC será criada/configurada. O app precisa suportar ambas as MCCs em paralelo, com seus próprios tokens de API.

## Objetivo

Abrir espaço no app para múltiplos conjuntos de credenciais Google Ads (OAuth + developer token), permitindo que cada `google_accounts` utilize o API set correto. A MCC antiga continua operando; a nova MCC será cadastrada sem afetar a existente.

## Mudanças técnicas

### 1. Banco de dados

Adicionar coluna `api_set` (inteiro, default 1) na tabela `public.google_accounts`.

- `api_set` indica qual conjunto de secrets usar (1, 2, 3...).
- Default 1 preserva comportamento atual para todas as contas já cadastradas.

### 2. Secrets do backend

Criar padrão de secrets escalável:

- `GOOGLE_CLIENT_ID_1`, `GOOGLE_CLIENT_SECRET_1`, `GOOGLE_ADS_DEVELOPER_TOKEN_1` → MCC antiga (já existem, renomeados mantendo fallback).
- `GOOGLE_CLIENT_ID_2`, `GOOGLE_CLIENT_SECRET_2`, `GOOGLE_ADS_DEVELOPER_TOKEN_2` → nova MCC.
- `GOOGLE_CLIENT_ID_3`... se necessário.

Os secrets atuais (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`) continuam como fallback `api_set = 1` para não quebrar o que já está rodando.

### 3. Edge functions

Criar helper compartilhado em `supabase/functions/_shared/google_api_set.ts` que resolve:

```text
api_set=1 -> GOOGLE_CLIENT_ID_1 / GOOGLE_CLIENT_SECRET_1 / GOOGLE_ADS_DEVELOPER_TOKEN_1
             fallback -> GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_ADS_DEVELOPER_TOKEN
api_set=2 -> GOOGLE_CLIENT_ID_2 / GOOGLE_CLIENT_SECRET_2 / GOOGLE_ADS_DEVELOPER_TOKEN_2
...e assim por diante
```

Atualizar as seguintes edge functions para usarem o helper e passar/receber `api_set`:

- `google-ads-oauth-start` → recebe `api_set` por query/body e gera URL de OAuth com o client ID correto.
- `google-ads-oauth-callback` → recebe `api_set` e salva a conta associada ao conjunto correto.
- `google-ads-sync-campaigns`
- `google-ads-sync-countries`
- `google-ads-sync-creatives`
- `google-ads-sync-placements`
- `google-ads-mutate`
- `google-ads-list-accounts`
- `google-ads-apply-utm-bulk`

Todas elas buscam o `refresh_token` e o `api_set` da tabela `google_accounts` antes de chamar a API Google Ads.

### 4. Frontend

Atualizar `src/pages/Settings.tsx` e `src/components/dashboard/IntegrationsPanel.tsx`:

- Botão "Conectar MCC" passa a abrir um diálogo com seleção de "API set" (MCC 1, MCC 2...).
- Listar as MCCs conectadas com a badge do API set usado.
- Sincronização automática usa o `api_set` de cada conta.

### 5. Status/check de configuração

Atualizar `google-ads-oauth-status` para retornar status de cada API set configurado (`1`, `2`, etc.), facilitando saber se os secrets da nova MCC foram preenchidos.

## Próximos passos

1. Confirmar se a nova MCC já possui OAuth app criado no Google Cloud Console e se o developer token já foi solicitado/aprovado.
2. Aprovar este plano.
3. Implementar as mudanças.
4. Cadastrar os secrets da nova MCC (`GOOGLE_CLIENT_ID_2`, `GOOGLE_CLIENT_SECRET_2`, `GOOGLE_ADS_DEVELOPER_TOKEN_2`).
5. Conectar a nova MCC pelo app e sincronizar as campanhas.

## Nota sobre acesso à API

O print mostra "Acesso às Análises" — para poder editar campanhas (aumentar budget, pausar, etc.) é necessário solicitar **"Acesso básico"** na Central de API. A nova MCC também precisará passar por esse processo. Enquanto estiver em "Análises", o app lê dados mas não aplica alterações.
