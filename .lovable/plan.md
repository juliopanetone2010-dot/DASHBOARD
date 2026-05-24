# Admins / Controle de Acesso — Plano de Implementação

Esse é um épico grande (RBAC + multi-tenant + auditoria + login próprio + hardening de todas as edge functions). Vou entregar em **fases**, começando pelo núcleo funcional e depois endurecendo segurança em todas as edge functions existentes.

---

## Decisões importantes (antes de começar)

1. **Login dos admins = Supabase Auth existente.** Não vou criar tabela `admin_users` com `password_hash` próprio — isso quebraria a autenticação atual e é inseguro de reimplementar. Em vez disso uso `auth.users` + tabela `admin_profiles` com role/metadata. Bcrypt, JWT, session expiration, recuperação de senha já vêm prontos do Supabase Auth (que é o padrão da Lovable Cloud). Atende todos os requisitos de segurança da seção 10 sem reinventar a roda.
2. **Rate limit / anti brute-force**: o backend da Lovable Cloud não tem primitivas próprias pra isso ainda. Vou anotar como gap conhecido — Supabase Auth já tem proteção básica embutida no endpoint de login.
3. **Multi-site real**: filtros de site já existem no front (`FilterContext`, `GlobalSiteSelector`). Vou plugar o ACL nele + criar RLS helpers no banco pra garantir no servidor também.
4. **Billing / whitelabel / planos (seção 13)**: deixo o schema preparado (campo `plan` em `admin_profiles`, tabela `organizations` opcional) mas **não implemento UI de billing agora** — sem isso o escopo dobra. Posso fazer numa próxima rodada.

---

## Fase 1 — Banco de dados

Migração com:

- `app_role` enum: `super_admin`, `admin`, `media_buyer`, `adops`, `viewer`, `site_manager`
- `admin_profiles` (1:1 com `auth.users`): `user_id`, `name`, `role`, `is_active`, `created_by`, `last_login_at`
- `admin_site_access`: `user_id`, `site_id` (quais sites o user vê)
- `admin_permissions`: `user_id` + 17 booleans da lista (can_view_dashboard, can_sync, can_edit_rules, can_run_automation, can_pause_campaigns, can_scale_campaigns, can_view_revenue, can_view_profit, can_manage_push, can_manage_users, can_use_migration, can_use_funil, can_use_geo_expansion, can_use_placements_cleanup, can_edit_budgets, can_edit_cpa, can_view_logs)
- `admin_audit_logs`: `user_id`, `action`, `resource_type`, `resource_id`, `site_id`, `campaign_id`, `before`, `after`, `ip`, `user_agent`, `created_at`
- **Funções SECURITY DEFINER** (evita recursão RLS):
  - `is_super_admin(uid)`
  - `has_permission(uid, perm_name text)`
  - `has_site_access(uid, site_id)` → super_admin sempre `true`
  - `current_role(uid)`
- **RLS em todas as 4 tabelas novas**: usuário vê o próprio perfil; super_admin vê/edita todos
- **Trigger** `on_auth_user_created` → cria `admin_profiles` + `admin_permissions` zeradas (primeiro user vira `super_admin` automaticamente; demais entram como `viewer` inativo até super_admin liberar)

---

## Fase 2 — Hook + Context de ACL no front

- `useAdminAcl()` (React Query): retorna `{ role, permissions, allowedSiteIds, isSuperAdmin, can(perm), canAccessSite(id) }`
- `AclProvider` injeta no app
- `<RequirePermission perm="...">` e `<RequireRole role="...">` para guardar telas/botões

---

## Fase 3 — Sidebar dinâmica

- Refatorar a navegação principal (atualmente as tabs do `Index.tsx`) pra ler de uma config `{ key, label, perm }`
- Esconder tabs sem permissão; super_admin vê tudo
- Aplicar nos botões de ação críticos (sync, pause, scale, migration, geo, placements cleanup, edit CPA/budget)

---

## Fase 4 — Página `Admins / Controle de Acesso`

Nova rota `/admins` (só visível com `can_manage_users` ou super_admin):

- Tabela de usuários: Nome, Email, Role (badge), Sites permitidos (chips), Último login, Status (ativo/bloqueado), Ações
- Botões: editar / bloquear / resetar senha / excluir
- Modal **Criar usuário**: Nome, Email, Senha, Role, Sites (multi-select), Permissões (checkboxes agrupadas)
- Modal **Editar**: mesmos campos
- "Resetar senha" = dispara `resetPasswordForEmail`
- "Excluir" = soft delete (`is_active = false`) — delete real só via edge function admin
- Aba secundária **Audit logs**: tabela filtrada por usuário/ação/data

Estilo SaaS: cards de stats no topo (total users, ativos por role), tabela com filtros instantâneos, sem reload (React Query).

---

## Fase 5 — Edge function `admin-users-manage`

Centraliza operações privilegiadas (criar/editar/excluir/resetar):

- Valida JWT do caller via `getClaims`
- Verifica `is_super_admin` OR `can_manage_users`
- Usa `service_role` pra criar user em `auth.admin.createUser`, atualizar `admin_profiles`, `admin_site_access`, `admin_permissions`
- Loga tudo em `admin_audit_logs`

---

## Fase 6 — Hardening de edge functions existentes

Adicionar helper `_shared/acl.ts` com:

```ts
assertPermission(supabase, jwt, "can_sync")
assertSiteAccess(supabase, jwt, siteId)
logAudit(supabase, { user, action, before, after, site_id, campaign_id, ip })
```

Aplicar em:

- `google-ads-sync-*` → `can_sync` + `has_site_access`
- `google-ads-mutate`, `campaign-restart`, `google-ads-apply-utm-bulk` → `can_pause_campaigns` / `can_edit_budgets` / `can_edit_cpa`
- `automation-run`, `automation-revert`, `funnel-smart-run`, `scale-unlock-run` → `can_run_automation`
- `placements-cleanup`, `placements-undo` → `can_use_placements_cleanup`
- `geo-cleanup`, `geo-expansion` → `can_use_geo_expansion`
- `migration-*` → `can_use_migration`
- `gam-sync-revenue` etc. → `can_view_revenue`

Cada mutação grava `admin_audit_logs` com before/after.

---

## Fase 7 — Filtros de site no servidor

`FilterContext` já passa `siteIds`. Vou:

- Forçar `allowedSiteIds` como interseção no `useDashboardData` e nos invokes de edge
- Edge functions ignoram `siteIds` enviados que não estão no `admin_site_access` do caller

---

## Notas técnicas

- **Bcrypt/JWT/session/timeout/reset de senha**: tudo via Supabase Auth (já presente). Nada custom.
- **RLS**: tabelas novas com `auth.uid()` direto; permissões verificadas via funções SECURITY DEFINER pra não recursar.
- **Primeiro super_admin**: o trigger marca o primeiro user criado como `super_admin`. Em projetos já populados, faço um seed que promove o user mais antigo.
- **Rate limit**: não implementado (limitação atual da plataforma). Supabase Auth tem proteção básica embutida no `/auth/v1/token`.
- **Billing/whitelabel**: fora desta entrega.

---

## Ordem de entrega proposta

1. Fase 1 (migração) — peço aprovação separada
2. Fases 2 + 3 + 4 (front + página de admins) — entrega visível
3. Fase 5 (edge function de gestão)
4. Fases 6 + 7 (hardening + multi-site real no servidor)

Confirma que posso prosseguir nessa ordem? Em particular: **OK usar Supabase Auth (login atual) em vez de criar `admin_users` com `password_hash` próprio?** É a única decisão que muda o desenho.
