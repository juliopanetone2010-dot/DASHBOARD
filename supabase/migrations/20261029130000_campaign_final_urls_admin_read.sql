-- Usuários convidados (admin_site_access / admin_google_ads_permissions) não liam a Final URL:
-- a policy de campaign_final_urls só liberava o dono (auth.uid() = user_id).
-- Mesmo padrão de campaigns em 20260901020000_admin_read_policies.sql.
DROP POLICY IF EXISTS "admin granted campaign_final_urls read" ON public.campaign_final_urls;
CREATE POLICY "admin granted campaign_final_urls read" ON public.campaign_final_urls
  FOR SELECT USING (public.can_access_account(auth.uid(), google_account_id));
