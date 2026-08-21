# Plano para Separar Credenciais do Google Ads por MCC (Jardim Astral vs Universo)

Para separar as credenciais, usaremos o sistema de "API Sets" que já implementamos parcialmente. Cada conjunto de credenciais (ID do Cliente, Secret e Developer Token) terá seu próprio sufixo (ex: `_2`).

## Passos no Google Cloud Console
1. **Criar Novo Projeto:** Crie um novo projeto no Google Cloud exclusivo para a MCC do Jardim Astral.
2. **Ativar API:** Ative a "Google Ads API" nesse projeto.
3. **Tela de Consentimento (OAuth):**
   - Configure o nome do app (ex: "UDC Comphany - Jardim").
   - **Importante:** Adicione o e-mail da MCC do Jardim Astral como "Usuário de Teste" ou publique o app em produção.
   - **URIs de redirecionamento autorizados:** Adicione `https://ad-genius-tracker.lovable.app/oauth/google-ads/callback`.
4. **Criar Credenciais OAuth:**
   - Crie um "ID do cliente OAuth 2.0" (Tipo: Aplicativo Web).
   - Anote o `Client ID` e o `Client Secret`.
5. **Developer Token:**
   - Na MCC do Jardim Astral, vá em Ferramentas > Centro da API e crie um Developer Token.

## Configuração no Sistema (Ações Técnicas)

### 1. Salvar os novos Secrets
Você precisará adicionar esses valores usando a ferramenta de configurações (ou via `add_secret` se tiver acesso):
- `GOOGLE_CLIENT_ID_2`: O novo Client ID.
- `GOOGLE_CLIENT_SECRET_2`: O novo Client Secret.
- `GOOGLE_ADS_DEVELOPER_TOKEN_2`: O novo Developer Token da MCC Jardim.

### 2. Ajustar o Painel de Integrações
Vou garantir que a interface permita selecionar o "Conjunto 2" para listar as contas e que o processo de OAuth use as credenciais corretas.

### 3. Vincular Contas ao Conjunto Correto
No banco de dados, as contas da MCC Jardim Astral devem ter a coluna `api_set` definida como `2`. O sistema de sincronização usará automaticamente as credenciais `_2` para essas contas.

---
**Deseja que eu comece a preparar a interface para receber essas credenciais do Conjunto 2?**
