
-- 1. Enum de roles
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('super_admin', 'admin', 'media_buyer', 'adops', 'viewer', 'site_manager');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. admin_profiles
CREATE TABLE IF NOT EXISTS public.admin_profiles (
  user_id uuid PRIMARY KEY,
  name text,
  role public.app_role NOT NULL DEFAULT 'viewer',
  is_active boolean NOT NULL DEFAULT false,
  created_by uuid,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. admin_site_access
CREATE TABLE IF NOT EXISTS public.admin_site_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_site_access_user ON public.admin_site_access(user_id);

-- 4. admin_permissions
CREATE TABLE IF NOT EXISTS public.admin_permissions (
  user_id uuid PRIMARY KEY,
  can_view_dashboard boolean NOT NULL DEFAULT true,
  can_sync boolean NOT NULL DEFAULT false,
  can_edit_rules boolean NOT NULL DEFAULT false,
  can_run_automation boolean NOT NULL DEFAULT false,
  can_pause_campaigns boolean NOT NULL DEFAULT false,
  can_scale_campaigns boolean NOT NULL DEFAULT false,
  can_view_revenue boolean NOT NULL DEFAULT false,
  can_view_profit boolean NOT NULL DEFAULT false,
  can_manage_push boolean NOT NULL DEFAULT false,
  can_manage_users boolean NOT NULL DEFAULT false,
  can_use_migration boolean NOT NULL DEFAULT false,
  can_use_funil boolean NOT NULL DEFAULT false,
  can_use_geo_expansion boolean NOT NULL DEFAULT false,
  can_use_placements_cleanup boolean NOT NULL DEFAULT false,
  can_edit_budgets boolean NOT NULL DEFAULT false,
  can_edit_cpa boolean NOT NULL DEFAULT false,
  can_view_logs boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5. admin_audit_logs
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  user_email text,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  site_id uuid,
  campaign_id text,
  before jsonb,
  after jsonb,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_user ON public.admin_audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON public.admin_audit_logs(action, created_at DESC);

-- 6. Security definer helpers
CREATE OR REPLACE FUNCTION public.is_super_admin(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.admin_profiles WHERE user_id = _uid AND role = 'super_admin' AND is_active = true) $$;

CREATE OR REPLACE FUNCTION public.admin_has_permission(_uid uuid, _perm text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE result boolean;
BEGIN
  IF public.is_super_admin(_uid) THEN RETURN true; END IF;
  EXECUTE format('SELECT %I FROM public.admin_permissions WHERE user_id = $1', _perm)
    INTO result USING _uid;
  RETURN COALESCE(result, false);
END $$;

CREATE OR REPLACE FUNCTION public.admin_has_site_access(_uid uuid, _site uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_super_admin(_uid)
    OR EXISTS (SELECT 1 FROM public.admin_site_access WHERE user_id = _uid AND site_id = _site)
$$;

-- 7. RLS
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_site_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- profiles
DROP POLICY IF EXISTS "self read profile" ON public.admin_profiles;
CREATE POLICY "self read profile" ON public.admin_profiles FOR SELECT
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "self update profile" ON public.admin_profiles;
CREATE POLICY "self update profile" ON public.admin_profiles FOR UPDATE
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()))
  WITH CHECK (auth.uid() = user_id OR public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "super insert profile" ON public.admin_profiles;
CREATE POLICY "super insert profile" ON public.admin_profiles FOR INSERT
  WITH CHECK (public.is_super_admin(auth.uid()) OR auth.uid() = user_id);
DROP POLICY IF EXISTS "super delete profile" ON public.admin_profiles;
CREATE POLICY "super delete profile" ON public.admin_profiles FOR DELETE
  USING (public.is_super_admin(auth.uid()));

-- site access
DROP POLICY IF EXISTS "read site access" ON public.admin_site_access;
CREATE POLICY "read site access" ON public.admin_site_access FOR SELECT
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "super manage site access" ON public.admin_site_access;
CREATE POLICY "super manage site access" ON public.admin_site_access FOR ALL
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

-- permissions
DROP POLICY IF EXISTS "read permissions" ON public.admin_permissions;
CREATE POLICY "read permissions" ON public.admin_permissions FOR SELECT
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "super manage permissions" ON public.admin_permissions;
CREATE POLICY "super manage permissions" ON public.admin_permissions FOR ALL
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

-- audit logs (read-only para super_admin e dono; writes só via service_role)
DROP POLICY IF EXISTS "read audit logs" ON public.admin_audit_logs;
CREATE POLICY "read audit logs" ON public.admin_audit_logs FOR SELECT
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));

-- 8. updated_at trigger
DROP TRIGGER IF EXISTS trg_admin_profiles_updated ON public.admin_profiles;
CREATE TRIGGER trg_admin_profiles_updated BEFORE UPDATE ON public.admin_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_admin_permissions_updated ON public.admin_permissions;
CREATE TRIGGER trg_admin_permissions_updated BEFORE UPDATE ON public.admin_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 9. Trigger: cria profile + permissions ao criar usuário; primeiro vira super_admin
CREATE OR REPLACE FUNCTION public.handle_new_admin_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  is_first boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.admin_profiles) INTO is_first;

  INSERT INTO public.admin_profiles (user_id, name, role, is_active)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    CASE WHEN is_first THEN 'super_admin'::public.app_role ELSE 'viewer'::public.app_role END,
    CASE WHEN is_first THEN true ELSE false END
  )
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.admin_permissions (user_id, can_view_dashboard)
  VALUES (NEW.id, true)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created_admin ON auth.users;
CREATE TRIGGER on_auth_user_created_admin
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_admin_user();

-- 10. Backfill: usuários existentes ganham profile; mais antigo vira super_admin
INSERT INTO public.admin_profiles (user_id, name, role, is_active)
SELECT u.id,
       COALESCE(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)),
       'viewer'::public.app_role,
       true
FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.admin_permissions (user_id, can_view_dashboard)
SELECT u.id, true FROM auth.users u
ON CONFLICT (user_id) DO NOTHING;

-- Promove o usuário mais antigo a super_admin se ainda não existir um
DO $$
DECLARE oldest uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_profiles WHERE role = 'super_admin') THEN
    SELECT id INTO oldest FROM auth.users ORDER BY created_at ASC LIMIT 1;
    IF oldest IS NOT NULL THEN
      UPDATE public.admin_profiles SET role = 'super_admin', is_active = true WHERE user_id = oldest;
    END IF;
  END IF;
END $$;
