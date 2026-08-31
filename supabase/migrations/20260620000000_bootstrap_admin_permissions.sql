-- BOOTSTRAP: admin_permissions — per-user feature flags. Created manually in the
-- old Lovable database and never captured as a migration. Referenced by
-- functions/admin-users and by the brayan/rilker seed migrations that follow.

CREATE TABLE IF NOT EXISTS public.admin_permissions (
  user_id uuid PRIMARY KEY,
  can_view_dashboard boolean NOT NULL DEFAULT false,
  can_view_revenue boolean NOT NULL DEFAULT false,
  can_view_profit boolean NOT NULL DEFAULT false,
  can_view_logs boolean NOT NULL DEFAULT false,
  can_sync boolean NOT NULL DEFAULT false,
  can_run_automation boolean NOT NULL DEFAULT false,
  can_pause_campaigns boolean NOT NULL DEFAULT false,
  can_scale_campaigns boolean NOT NULL DEFAULT false,
  can_edit_budgets boolean NOT NULL DEFAULT false,
  can_edit_cpa boolean NOT NULL DEFAULT false,
  can_edit_rules boolean NOT NULL DEFAULT false,
  can_manage_push boolean NOT NULL DEFAULT false,
  can_manage_users boolean NOT NULL DEFAULT false,
  can_use_funil boolean NOT NULL DEFAULT false,
  can_use_geo_expansion boolean NOT NULL DEFAULT false,
  can_use_migration boolean NOT NULL DEFAULT false,
  can_use_placements_cleanup boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_permissions self read" ON public.admin_permissions;
CREATE POLICY "admin_permissions self read" ON public.admin_permissions
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.is_super_admin(auth.uid()));

DROP POLICY IF EXISTS "admin_permissions super manage" ON public.admin_permissions;
CREATE POLICY "admin_permissions super manage" ON public.admin_permissions
  FOR ALL TO authenticated
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_permissions TO authenticated;
GRANT ALL ON public.admin_permissions TO service_role;

DROP TRIGGER IF EXISTS trg_admin_permissions_updated_at ON public.admin_permissions;
CREATE TRIGGER trg_admin_permissions_updated_at
  BEFORE UPDATE ON public.admin_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
