ALTER TABLE public.campaign_automation
  ADD COLUMN IF NOT EXISTS winner_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS winner_country_code text NULL;