
-- 1. Adicionar 'manager' ao enum app_role (se ainda não existir)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'manager'
      AND enumtypid = 'public.app_role'::regtype
  ) THEN
    ALTER TYPE public.app_role ADD VALUE 'manager' BEFORE 'viewer';
  END IF;
END $$;

-- 2. Tabela admin_module_permissions
CREATE TABLE IF NOT EXISTS public.admin_module_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  module text NOT NULL,
  can_access boolean NOT NULL DEFAULT true,
  can_edit boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_module_permissions TO authenticated;
GRANT ALL ON public.admin_module_permissions TO service_role;

ALTER TABLE public.admin_module_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "self read module perms"
  ON public.admin_module_permissions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));

CREATE POLICY "super manage module perms"
  ON public.admin_module_permissions FOR ALL
  TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

-- 3. Tabela admin_google_ads_permissions
CREATE TABLE IF NOT EXISTS public.admin_google_ads_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  google_account_id uuid NOT NULL,
  can_view boolean NOT NULL DEFAULT true,
  can_sync boolean NOT NULL DEFAULT false,
  can_migrate boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_account_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_google_ads_permissions TO authenticated;
GRANT ALL ON public.admin_google_ads_permissions TO service_role;

ALTER TABLE public.admin_google_ads_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "self read ga perms"
  ON public.admin_google_ads_permissions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));

CREATE POLICY "super manage ga perms"
  ON public.admin_google_ads_permissions FOR ALL
  TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

-- 4. Trigger updated_at nas novas tabelas
DROP TRIGGER IF EXISTS trg_module_perms_updated ON public.admin_module_permissions;
CREATE TRIGGER trg_module_perms_updated
  BEFORE UPDATE ON public.admin_module_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_ga_perms_updated ON public.admin_google_ads_permissions;
CREATE TRIGGER trg_ga_perms_updated
  BEFORE UPDATE ON public.admin_google_ads_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. effective_role: retorna o papel efetivo do usuário
CREATE OR REPLACE FUNCTION public.effective_role(_uid uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT role::text FROM public.admin_profiles
       WHERE user_id = _uid AND is_active = true
       LIMIT 1),
    'viewer'
  );
$$;

-- 6. accessible_sites: lista de site_ids que o usuário pode acessar
CREATE OR REPLACE FUNCTION public.accessible_sites(_uid uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id FROM public.sites s WHERE s.user_id = _uid
  UNION
  SELECT a.site_id FROM public.admin_site_access a WHERE a.user_id = _uid
  UNION
  SELECT s.id FROM public.sites s WHERE public.is_super_admin(_uid);
$$;

-- 7. can_access_module: checa permissão de módulo
CREATE OR REPLACE FUNCTION public.can_access_module(_uid uuid, _module text, _need_edit boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin(_uid)
    OR EXISTS (
      SELECT 1 FROM public.admin_module_permissions p
      WHERE p.user_id = _uid
        AND p.module = _module
        AND p.can_access = true
        AND (NOT _need_edit OR p.can_edit = true)
    )
    -- fallback: se o usuário não tem nenhuma linha em admin_module_permissions,
    -- assumimos legacy single-user (acesso total ao próprio dado)
    OR NOT EXISTS (
      SELECT 1 FROM public.admin_module_permissions p WHERE p.user_id = _uid
    );
$$;

-- 8. can_access_google_account_v2: usa admin_google_ads_permissions
CREATE OR REPLACE FUNCTION public.can_access_google_account(_uid uuid, _account_id uuid, _need_sync boolean DEFAULT false, _need_migrate boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _account_id IS NOT NULL AND (
    public.is_super_admin(_uid)
    OR EXISTS (SELECT 1 FROM public.google_accounts g WHERE g.id = _account_id AND g.user_id = _uid)
    OR EXISTS (
      SELECT 1 FROM public.admin_google_ads_permissions p
      WHERE p.user_id = _uid
        AND p.google_account_id = _account_id
        AND p.can_view = true
        AND (NOT _need_sync OR p.can_sync = true)
        AND (NOT _need_migrate OR p.can_migrate = true)
    )
    OR EXISTS (
      SELECT 1 FROM public.account_site_links l
      JOIN public.admin_site_access a ON a.site_id = l.site_id
      WHERE l.google_account_id = _account_id AND a.user_id = _uid
    )
  )
$$;
