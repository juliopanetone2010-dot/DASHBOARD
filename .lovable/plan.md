# Plano: SaaS multi-tenant com RBAC e isolamento por site

Trabalho grande — vou entregar em **5 fases** pra você poder testar e reverter qualquer uma sem quebrar o sistema. Cada fase é independente e funcional.

## Fase 1 — Schema RBAC + Super Admin (backend-only, sem UI)

Reaproveitar as tabelas que já existem (`admin_profiles`, `admin_permissions`, `admin_site_access`) e completar o que falta:

**Nova tabela** `admin_google_ads_permissions` — quais contas Google Ads cada admin pode acessar (hoje só existe por site).

**Nova tabela** `admin_module_permissions` — controle granular por módulo (Dashboard, Placements, Attribution, Funil, Países, Criativos, Push, Automação, Destravar Escala, Migração, Regras, Integrações, AI, Admins).

**Nova tabela** `admin_action_logs` — auditoria de ações sensíveis (já existe `admin_audit_logs` parecida; vou consolidar nela em vez de duplicar).

**Helpers SQL (SECURITY DEFINER)** novos:
- `can_access_module(uid, module_name)` — checa se o usuário pode ver/editar um módulo
- `can_access_google_account(uid, account_id)` — já existe parcial em `can_access_account`, vou expandir
- `effective_role(uid)` — devolve `super_admin | admin | manager | viewer`
- `accessible_sites(uid)` → setof uuid — lista de sites permitidos (usada em RLS via `site_id IN (...)`)

**Roles do enum** `app_role`: adicionar `manager` se não existir (já tem `super_admin`, `admin`, `viewer`).

**RLS revisada** em **todas** as tabelas que têm `site_id` ou `google_account_id`: as policies já cobrem o caso single-user (`auth.uid() = user_id`) e admin (`can_access_site`/`can_access_account`). Vou adicionar policies de UPDATE/DELETE/INSERT pra admins seguindo o RBAC (hoje só leitura está liberada).

## Fase 2 — Edge function guards

Criar `supabase/functions/_shared/rbac.ts` com:
- `requireUser(req)` — valida JWT e devolve userId
- `requireSiteAccess(userId, siteId)` — 403 se não pode
- `requireAccountAccess(userId, accountId)` — 403 se não pode
- `requireModule(userId, module, action)` — 403 se sem permissão
- `requireSuperAdmin(userId)` — gates globais

Aplicar em **todas** as 30+ edge functions críticas: `gam-sync-revenue`, `google-ads-sync-*`, `placements-cleanup`, `automation-run`, `funnel-smart-run`, `migration-execute`, `geo-cleanup`, `scale-unlock-run`, `campaign-restart`, `placements-undo`, `automation-revert`, etc.

## Fase 3 — Site Selector como source-of-truth global

Hoje o `GlobalSiteSelector` + `FilterContext` já existem mas não são respeitados consistentemente. Vou:
- Garantir que **toda** chamada de hook (`useDashboardData`, `useSiteOnboarding`, etc.) passe `siteId` ativo
- Toda invocação de edge function recebe `site_id` no body e a função valida acesso
- AI Assistant (`ai_threads.context`) grava o `site_id` ativo e o prompt do sistema injeta apenas dados desse site
- Adicionar guard no `RequireAuth` que bloqueia rotas se nenhum site selecionado (exceto super admin)

## Fase 4 — Página Admins (`/admin`)

Nova rota `/admin` (visível só pra `super_admin` e `admin` com `can_manage_users`):
- Lista de usuários com role, status, último login
- Criar usuário (envia magic link ou senha temporária via `admin.inviteUserByEmail`)
- Editar role, ativar/desativar
- Matriz de permissões: sites × can_view/edit/sync/delete/automate
- Matriz de contas Google Ads acessíveis
- Matriz de módulos com toggle can_access/can_edit
- Resetar senha (envia recovery email)
- Aba "Logs de acesso" lendo `admin_audit_logs`

UI: tabela shadcn + dialogs pra editar, badges coloridos por role.

## Fase 5 — UX final + segurança

- Badge de role no header (`Super Admin` / `Admin` / `Manager` / `Viewer`) com cor
- Avatar + dropdown perfil → `/perfil`
- Página `/perfil` com nome, avatar, troca de senha
- Troca rápida de site no header (já existe, melhorar UX com busca)
- Ocultar abas/botões que o usuário não tem permissão (UI guard — backend já bloqueia)
- HIBP check ativado nas senhas (`configure_auth`)
- Audit log automático em mutations sensíveis (delete placement, pausar campanha, mudar budget) via trigger SQL

## O que NÃO entra neste plano

- **Rate limiting / brute force**: o backend não tem primitivas nativas pra isso ainda — vou pular conforme política da plataforma. Supabase Auth já tem proteção básica contra brute force em login.
- **Billing**: você mencionou "billing futuro" — fica pra depois, não bloqueia nada.
- **Refresh token customizado**: o Supabase já gerencia refresh tokens automaticamente; não precisa reinventar.

## Notas técnicas

**Reutilização vs criação**: já existem `admin_profiles`, `admin_permissions`, `admin_site_access`, `admin_audit_logs`, `is_super_admin()`, `admin_has_permission()`, `can_access_site()`, `can_access_account()`, `can_access_campaign()`. Vou **estender** isso em vez de criar tabelas paralelas — assim seu usuário super_admin atual continua válido sem migração de dados.

**Risco**: cada fase mexe em RLS. Vou rodar `supabase--linter` depois de cada migration pra garantir que nada quebrou pra usuários comuns. Se algo travar, dá pra reverter via histórico do Lovable.

## Como você prefere começar?

Posso começar pela **Fase 1 + 2** juntas (backend RBAC completo, invisível na UI mas já protegido) — esse é o pulo de qualidade que destrava todo o resto. Confirma que eu sigo, ou prefere começar pela Fase 4 (página de Admins) primeiro pra você já conseguir convidar gente?
