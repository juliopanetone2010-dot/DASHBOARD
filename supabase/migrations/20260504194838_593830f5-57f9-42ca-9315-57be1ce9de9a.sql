-- Config columns
ALTER TABLE public.rules_config
  ADD COLUMN IF NOT EXISTS geo_expansion_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS geo_expansion_min_roi_pct numeric NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS geo_expansion_min_campaign_cost_brl numeric NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS geo_expansion_min_country_cost_brl numeric NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS geo_expansion_min_countries integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS geo_expansion_lookback_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS geo_expansion_interval_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS geo_expansion_budget_multiplier numeric NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS geo_expansion_last_run_at timestamptz;

-- Logs table
CREATE TABLE IF NOT EXISTS public.campaign_expansion_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid,
  google_account_id uuid,
  original_campaign_id text NOT NULL,
  original_campaign_name text,
  new_campaign_id text,
  new_campaign_name text,
  country_code text NOT NULL,
  country_name text,
  country_criterion_id text,
  roi_pct numeric,
  cost_brl numeric,
  revenue_brl numeric,
  budget_micros bigint,
  action text NOT NULL DEFAULT 'suggested', -- suggested | created | failed
  status text NOT NULL DEFAULT 'pending',
  error text,
  payload jsonb,
  executed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.campaign_expansion_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own expansion logs"
  ON public.campaign_expansion_logs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_geo_exp_logs_user_camp
  ON public.campaign_expansion_logs (user_id, original_campaign_id, country_code);
CREATE INDEX IF NOT EXISTS idx_geo_exp_logs_site
  ON public.campaign_expansion_logs (site_id, executed_at DESC);