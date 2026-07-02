
ALTER TABLE public.gam_url_ad_unit_daily
  ADD COLUMN IF NOT EXISTS campaign_id TEXT,
  ALTER COLUMN url_normalized DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gam_url_ad_unit_daily_campaign
  ON public.gam_url_ad_unit_daily (campaign_id, date DESC);

-- Substitui a unique key para permitir agrupamento por campaign_id
ALTER TABLE public.gam_url_ad_unit_daily
  DROP CONSTRAINT IF EXISTS gam_url_ad_unit_daily_user_id_google_account_id_date_url_no_key;

ALTER TABLE public.gam_url_ad_unit_daily
  ADD CONSTRAINT gam_url_ad_unit_daily_unique_key
  UNIQUE (user_id, google_account_id, date, campaign_id, ad_unit_name);
