
-- Tabela de logs de limpeza de países
CREATE TABLE public.geo_cleanup_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid,
  google_account_id uuid,
  campaign_id text NOT NULL,
  campaign_name text,
  country_code text NOT NULL,
  country_name text,
  country_criterion_id text,
  roi_pct numeric,
  cost_brl numeric,
  revenue_brl numeric,
  action text NOT NULL DEFAULT 'suggested', -- 'removed' | 'suggested'
  lookback_days integer NOT NULL DEFAULT 15,
  executed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.geo_cleanup_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own geo cleanup logs"
ON public.geo_cleanup_logs FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_geo_cleanup_logs_user_exec ON public.geo_cleanup_logs(user_id, executed_at DESC);
CREATE INDEX idx_geo_cleanup_logs_campaign ON public.geo_cleanup_logs(campaign_id);

-- Configurações em rules_config
ALTER TABLE public.rules_config
  ADD COLUMN IF NOT EXISTS geo_auto_cleanup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS geo_cleanup_max_roi_pct numeric NOT NULL DEFAULT -10,
  ADD COLUMN IF NOT EXISTS geo_cleanup_min_cost_brl numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS geo_cleanup_min_countries integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS geo_cleanup_min_campaign_cost_brl numeric NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS geo_cleanup_interval_days integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS geo_cleanup_lookback_days integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS geo_cleanup_last_run_at timestamptz;
