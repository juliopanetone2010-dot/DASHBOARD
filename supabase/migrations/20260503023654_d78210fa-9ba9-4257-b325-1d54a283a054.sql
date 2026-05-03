ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_user_id_campaign_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_user_account_campaign_unique'
  ) THEN
    ALTER TABLE public.campaigns
      ADD CONSTRAINT campaigns_user_account_campaign_unique UNIQUE (user_id, google_account_id, campaign_id);
  END IF;
END $$;

ALTER TABLE public.daily_metrics
  DROP CONSTRAINT IF EXISTS daily_metrics_user_id_campaign_id_date_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'daily_metrics_user_account_campaign_date_unique'
  ) THEN
    ALTER TABLE public.daily_metrics
      ADD CONSTRAINT daily_metrics_user_account_campaign_date_unique UNIQUE (user_id, google_account_id, campaign_id, date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_campaigns_user_account
  ON public.campaigns(user_id, google_account_id);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_user_account_date
  ON public.daily_metrics(user_id, google_account_id, date DESC);