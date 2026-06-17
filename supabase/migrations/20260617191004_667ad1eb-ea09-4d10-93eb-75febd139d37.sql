GRANT SELECT ON public.gam_campaign_source_revenue TO authenticated;
GRANT ALL ON public.gam_campaign_source_revenue TO service_role;

DROP POLICY IF EXISTS "admin granted read" ON public.gam_campaign_source_revenue;
CREATE POLICY "admin granted read"
ON public.gam_campaign_source_revenue
FOR SELECT
TO authenticated
USING (public.can_access_site(auth.uid(), site_id));