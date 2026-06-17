CREATE POLICY "admin granted site metrics read"
ON public.site_metrics_daily
FOR SELECT
TO authenticated
USING (public.can_access_site(auth.uid(), site_id));