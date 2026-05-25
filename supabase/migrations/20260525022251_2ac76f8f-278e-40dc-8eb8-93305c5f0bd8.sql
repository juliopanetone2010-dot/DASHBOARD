-- ============ HELPERS ============
CREATE OR REPLACE FUNCTION public.can_access_site(_uid uuid, _site_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _site_id IS NOT NULL AND (
    public.is_super_admin(_uid)
    OR EXISTS (SELECT 1 FROM public.sites s WHERE s.id = _site_id AND s.user_id = _uid)
    OR EXISTS (SELECT 1 FROM public.admin_site_access a WHERE a.site_id = _site_id AND a.user_id = _uid)
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_account(_uid uuid, _account_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _account_id IS NOT NULL AND (
    public.is_super_admin(_uid)
    OR EXISTS (SELECT 1 FROM public.google_accounts g WHERE g.id = _account_id AND g.user_id = _uid)
    OR EXISTS (
      SELECT 1 FROM public.account_site_links l
      JOIN public.admin_site_access a ON a.site_id = l.site_id
      WHERE l.google_account_id = _account_id AND a.user_id = _uid
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.can_access_campaign(_uid uuid, _campaign_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _campaign_id IS NOT NULL AND (
    public.is_super_admin(_uid)
    OR EXISTS (
      SELECT 1 FROM public.campaigns c
      WHERE c.campaign_id = _campaign_id
      AND (c.user_id = _uid OR public.can_access_account(_uid, c.google_account_id))
    )
  )
$$;

GRANT EXECUTE ON FUNCTION public.can_access_site(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_account(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_campaign(uuid, text) TO authenticated;

-- ============ SITES ============
DROP POLICY IF EXISTS "admin granted site read" ON public.sites;
CREATE POLICY "admin granted site read" ON public.sites FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), id));

-- ============ ACCOUNT LINKS ============
DROP POLICY IF EXISTS "admin granted links read" ON public.account_site_links;
CREATE POLICY "admin granted links read" ON public.account_site_links FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id) OR public.can_access_account(auth.uid(), google_account_id));

-- ============ GOOGLE ACCOUNTS ============
DROP POLICY IF EXISTS "admin granted google accounts read" ON public.google_accounts;
CREATE POLICY "admin granted google accounts read" ON public.google_accounts FOR SELECT TO authenticated
USING (public.can_access_account(auth.uid(), id));

-- ============ CAMPAIGNS ============
DROP POLICY IF EXISTS "admin granted campaigns read" ON public.campaigns;
CREATE POLICY "admin granted campaigns read" ON public.campaigns FOR SELECT TO authenticated
USING (public.can_access_account(auth.uid(), google_account_id));

-- ============ Tabelas com site_id ============
DROP POLICY IF EXISTS "admin granted read" ON public.automation_logs;
CREATE POLICY "admin granted read" ON public.automation_logs FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id) OR public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.campaign_automation;
CREATE POLICY "admin granted read" ON public.campaign_automation FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id) OR public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.campaign_expansion_logs;
CREATE POLICY "admin granted read" ON public.campaign_expansion_logs FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.campaign_funnel;
CREATE POLICY "admin granted read" ON public.campaign_funnel FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id) OR public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.campaign_funnel_logs;
CREATE POLICY "admin granted read" ON public.campaign_funnel_logs FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id) OR public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.campaign_migrations;
CREATE POLICY "admin granted read" ON public.campaign_migrations FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), source_site_id) OR public.can_access_site(auth.uid(), destination_site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.campaign_restart_flow;
CREATE POLICY "admin granted read" ON public.campaign_restart_flow FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id) OR public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.daily_financial_snapshots;
CREATE POLICY "admin granted read" ON public.daily_financial_snapshots FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.gam_campaign_source_revenue;
CREATE POLICY "admin granted read" ON public.gam_campaign_source_revenue FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.gam_placement_revenue;
CREATE POLICY "admin granted read" ON public.gam_placement_revenue FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.gam_url_revenue;
CREATE POLICY "admin granted read" ON public.gam_url_revenue FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.geo_cleanup_logs;
CREATE POLICY "admin granted read" ON public.geo_cleanup_logs FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.placement_cleanup_logs;
CREATE POLICY "admin granted read" ON public.placement_cleanup_logs FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.placement_status;
CREATE POLICY "admin granted read" ON public.placement_status FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id) OR public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.placement_status_history;
CREATE POLICY "admin granted read" ON public.placement_status_history FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.placements;
CREATE POLICY "admin granted read" ON public.placements FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.push_url_revenue;
CREATE POLICY "admin granted read" ON public.push_url_revenue FOR SELECT TO authenticated
USING (public.can_access_site(auth.uid(), site_id));

DROP POLICY IF EXISTS "admin granted read" ON public.campaign_country_metrics;
CREATE POLICY "admin granted read" ON public.campaign_country_metrics FOR SELECT TO authenticated
USING (public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.creative_metrics;
CREATE POLICY "admin granted read" ON public.creative_metrics FOR SELECT TO authenticated
USING (public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.ads_placements;
CREATE POLICY "admin granted read" ON public.ads_placements FOR SELECT TO authenticated
USING (public.can_access_account(auth.uid(), google_account_id));

DROP POLICY IF EXISTS "admin granted read" ON public.daily_metrics;
CREATE POLICY "admin granted read" ON public.daily_metrics FOR SELECT TO authenticated
USING (public.can_access_campaign(auth.uid(), campaign_id));

DROP POLICY IF EXISTS "admin granted read" ON public.automation_actions;
CREATE POLICY "admin granted read" ON public.automation_actions FOR SELECT TO authenticated
USING (public.can_access_campaign(auth.uid(), campaign_id));

DROP POLICY IF EXISTS "admin granted read" ON public.placement_actions;
CREATE POLICY "admin granted read" ON public.placement_actions FOR SELECT TO authenticated
USING (public.can_access_campaign(auth.uid(), campaign_id));

DROP POLICY IF EXISTS "admin granted read" ON public.alerts;
CREATE POLICY "admin granted read" ON public.alerts FOR SELECT TO authenticated
USING (public.can_access_campaign(auth.uid(), campaign_id));