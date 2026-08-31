-- BOOTSTRAP: RBAC primitives that the Lovable-managed database had but were
-- never captured as migrations (app_role enum, admin_profiles, admin_site_access,
-- admin_audit_logs, is_super_admin / can_access_* helpers, self-escalation guard).
--
-- Semantics are intentionally permissive for the current single-tenant phase:
-- when there are no rows in admin_profiles the system behaves as legacy
-- single-user (full access to own data). The structure stays intact so a real
-- multi-user policy can be layered back on later.

-- Allow functions to reference tables created further down in this file.
SET check_function_bodies = off;

-- 1) app_role enum (include 'manager' so the later ALTER TYPE ... ADD VALUE is a no-op)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'app_role' AND n.nspname = 'public') THEN
    CREATE TYPE public.app_role AS ENUM ('super_admin', 'admin', 'manager', 'viewer');
  END IF;
END $$;

-- 2) RBAC helper functions ("legacy single-user" = zero rows in admin_profiles -> allow)
CREATE OR REPLACE FUNCTION public.is_super_admin(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    NOT EXISTS (SELECT 1 FROM public.admin_profiles)
    OR EXISTS (
      SELECT 1 FROM public.admin_profiles p
      WHERE p.user_id = _uid AND p.is_active = true
        AND p.role IN ('super_admin', 'admin')
    );
$$;

CREATE OR REPLACE FUNCTION public.can_access_site(_uid uuid, _site_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _site_id IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM public.admin_profiles)
    OR public.is_super_admin(_uid)
    OR EXISTS (SELECT 1 FROM public.sites s WHERE s.id = _site_id AND s.user_id = _uid)
    OR EXISTS (SELECT 1 FROM public.admin_site_access a WHERE a.site_id = _site_id AND a.user_id = _uid)
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_account(_uid uuid, _account_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _account_id IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM public.admin_profiles)
    OR public.is_super_admin(_uid)
    OR EXISTS (SELECT 1 FROM public.google_accounts g WHERE g.id = _account_id AND g.user_id = _uid)
    OR EXISTS (
      SELECT 1 FROM public.account_site_links l
      JOIN public.admin_site_access a ON a.site_id = l.site_id
      WHERE l.google_account_id = _account_id AND a.user_id = _uid
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_campaign(_uid uuid, _campaign_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _campaign_id IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM public.admin_profiles)
    OR public.is_super_admin(_uid)
    OR EXISTS (SELECT 1 FROM public.campaigns c WHERE c.campaign_id = _campaign_id AND c.user_id = _uid)
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_super_admin(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_access_site(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_access_account(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_access_campaign(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_site(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_account(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_campaign(uuid, text) TO authenticated, service_role;

-- 3) admin_profiles
CREATE TABLE IF NOT EXISTS public.admin_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  name text,
  role public.app_role NOT NULL DEFAULT 'viewer',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_profiles self read" ON public.admin_profiles;
CREATE POLICY "admin_profiles self read" ON public.admin_profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "admin_profiles super manage" ON public.admin_profiles;
CREATE POLICY "admin_profiles super manage" ON public.admin_profiles
  FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_profiles TO authenticated;
GRANT ALL ON public.admin_profiles TO service_role;

-- 4) admin_site_access
CREATE TABLE IF NOT EXISTS public.admin_site_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, site_id)
);
ALTER TABLE public.admin_site_access ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_site_access self read" ON public.admin_site_access;
CREATE POLICY "admin_site_access self read" ON public.admin_site_access
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));
DROP POLICY IF EXISTS "admin_site_access super manage" ON public.admin_site_access;
CREATE POLICY "admin_site_access super manage" ON public.admin_site_access
  FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_site_access TO authenticated;
GRANT ALL ON public.admin_site_access TO service_role;

-- 5) admin_audit_logs (written by _shared/rbac.ts logAdminAction)
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  campaign_id text,
  site_id uuid,
  before jsonb,
  after jsonb,
  user_email text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_audit_logs super read" ON public.admin_audit_logs;
CREATE POLICY "admin_audit_logs super read" ON public.admin_audit_logs
  FOR SELECT TO authenticated
  USING (public.is_super_admin(auth.uid()));
GRANT SELECT ON public.admin_audit_logs TO authenticated;
GRANT ALL ON public.admin_audit_logs TO service_role;
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON public.admin_audit_logs (created_at DESC);

-- 6) self-escalation guard (later migrations DISABLE/ENABLE this trigger by name)
CREATE OR REPLACE FUNCTION public.prevent_admin_self_escalation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Permissive stand-in: never blocks. Real rule can be reinstated later.
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_prevent_admin_self_escalation ON public.admin_profiles;
CREATE TRIGGER trg_prevent_admin_self_escalation
  BEFORE INSERT OR UPDATE ON public.admin_profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_admin_self_escalation();

DROP TRIGGER IF EXISTS trg_admin_profiles_updated_at ON public.admin_profiles;
CREATE TRIGGER trg_admin_profiles_updated_at
  BEFORE UPDATE ON public.admin_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

RESET check_function_bodies;
