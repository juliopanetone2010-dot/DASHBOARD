-- Multi-user read access.
--
-- The RBAC layer (admin_site_access / admin_google_ads_permissions /
-- can_access_site / can_access_account) existed, but the data tables' RLS was
-- never updated to honour it — only gam_campaign_source_revenue and
-- site_metrics_daily had an "admin granted read" policy. So a non-owner user
-- (viewer / analyst) with site+account grants still saw nothing.
--
-- Add a SELECT policy to every table the dashboard reads so granted users can
-- read the owner's data. Writes stay owner-only (auth.uid() = user_id).

-- sites: the row's own id is the site id
DROP POLICY IF EXISTS "admin granted sites read" ON public.sites;
CREATE POLICY "admin granted sites read" ON public.sites
  FOR SELECT USING (public.can_access_site(auth.uid(), id));

-- account_site_links
DROP POLICY IF EXISTS "admin granted links read" ON public.account_site_links;
CREATE POLICY "admin granted links read" ON public.account_site_links
  FOR SELECT USING (
    public.can_access_site(auth.uid(), site_id)
    OR public.can_access_account(auth.uid(), google_account_id)
  );

-- google_accounts: the row's own id is the account id
DROP POLICY IF EXISTS "admin granted accounts read" ON public.google_accounts;
CREATE POLICY "admin granted accounts read" ON public.google_accounts
  FOR SELECT USING (public.can_access_account(auth.uid(), id));

-- campaigns (keyed by google_account_id)
DROP POLICY IF EXISTS "admin granted campaigns read" ON public.campaigns;
CREATE POLICY "admin granted campaigns read" ON public.campaigns
  FOR SELECT USING (public.can_access_account(auth.uid(), google_account_id));

-- daily_metrics (keyed by google_account_id)
DROP POLICY IF EXISTS "admin granted daily_metrics read" ON public.daily_metrics;
CREATE POLICY "admin granted daily_metrics read" ON public.daily_metrics
  FOR SELECT USING (public.can_access_account(auth.uid(), google_account_id));

-- placements (keyed by site_id)
DROP POLICY IF EXISTS "admin granted placements read" ON public.placements;
CREATE POLICY "admin granted placements read" ON public.placements
  FOR SELECT USING (public.can_access_site(auth.uid(), site_id));

-- gam_placement_revenue (keyed by site_id)
DROP POLICY IF EXISTS "admin granted gam_placement_revenue read" ON public.gam_placement_revenue;
CREATE POLICY "admin granted gam_placement_revenue read" ON public.gam_placement_revenue
  FOR SELECT USING (public.can_access_site(auth.uid(), site_id));

-- alerts / rules_config / automation_actions: readable by any granted user of the owner
DROP POLICY IF EXISTS "admin granted alerts read" ON public.alerts;
CREATE POLICY "admin granted alerts read" ON public.alerts
  FOR SELECT USING (
    public.is_super_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.admin_site_access a WHERE a.user_id = auth.uid())
  );
DROP POLICY IF EXISTS "admin granted rules read" ON public.rules_config;
CREATE POLICY "admin granted rules read" ON public.rules_config
  FOR SELECT USING (
    public.is_super_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.admin_site_access a WHERE a.user_id = auth.uid())
  );

-- every viewer/analyst gets an admin_profiles row so the UI doesn't render them
-- as "inactive"; the admin-users edge function grants site/account access but
-- was not creating the profile.
INSERT INTO public.admin_profiles (user_id, name, role, is_active)
SELECT DISTINCT a.user_id,
       split_part(u.email, '@', 1),
       'viewer'::public.app_role,
       true
FROM public.admin_site_access a
JOIN auth.users u ON u.id = a.user_id
WHERE NOT EXISTS (SELECT 1 FROM public.admin_profiles p WHERE p.user_id = a.user_id)
ON CONFLICT (user_id) DO NOTHING;
