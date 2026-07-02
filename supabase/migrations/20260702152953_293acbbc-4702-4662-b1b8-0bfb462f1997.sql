
CREATE TABLE public.gam_url_ad_unit_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  google_account_id UUID,
  site_id UUID,
  date DATE NOT NULL,
  url_normalized TEXT NOT NULL,
  url_raw TEXT,
  ad_unit_name TEXT NOT NULL,
  ad_requests BIGINT NOT NULL DEFAULT 0,
  matched_impressions BIGINT NOT NULL DEFAULT 0,
  revenue_usd NUMERIC NOT NULL DEFAULT 0,
  match_rate_pct NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_account_id, date, url_normalized, ad_unit_name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gam_url_ad_unit_daily TO authenticated;
GRANT ALL ON public.gam_url_ad_unit_daily TO service_role;

ALTER TABLE public.gam_url_ad_unit_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "gam_url_ad_unit_daily_select" ON public.gam_url_ad_unit_daily
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_super_admin(auth.uid())
    OR public.can_access_account(auth.uid(), google_account_id)
    OR (site_id IS NOT NULL AND public.can_access_site(auth.uid(), site_id))
  );

CREATE POLICY "gam_url_ad_unit_daily_write" ON public.gam_url_ad_unit_daily
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin(auth.uid()))
  WITH CHECK (user_id = auth.uid() OR public.is_super_admin(auth.uid()));

CREATE INDEX idx_gam_url_ad_unit_daily_lookup
  ON public.gam_url_ad_unit_daily (user_id, url_normalized, date DESC);
CREATE INDEX idx_gam_url_ad_unit_daily_account_date
  ON public.gam_url_ad_unit_daily (google_account_id, date DESC);

CREATE TRIGGER trg_gam_url_ad_unit_daily_updated_at
  BEFORE UPDATE ON public.gam_url_ad_unit_daily
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
