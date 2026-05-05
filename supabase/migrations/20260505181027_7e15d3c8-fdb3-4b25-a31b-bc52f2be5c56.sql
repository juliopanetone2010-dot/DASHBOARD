CREATE TABLE IF NOT EXISTS public.creative_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  google_account_id uuid,
  campaign_id text NOT NULL,
  campaign_name text,
  ad_group_id text NOT NULL,
  ad_group_name text,
  ad_id text NOT NULL,
  ad_name text,
  ad_type text,
  ad_status text,
  date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost numeric NOT NULL DEFAULT 0,
  conversions numeric NOT NULL DEFAULT 0,
  revenue_usd numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_id, ad_group_id, ad_id, date)
);

CREATE INDEX IF NOT EXISTS idx_creative_metrics_user_camp_date
  ON public.creative_metrics (user_id, campaign_id, date);

ALTER TABLE public.creative_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own creative metrics"
  ON public.creative_metrics FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_creative_metrics_updated
  BEFORE UPDATE ON public.creative_metrics
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.rules_config
  ADD COLUMN IF NOT EXISTS creative_auto_optimize_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS creative_min_cost_brl numeric NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS creative_min_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS creative_min_roi_diff_pct numeric NOT NULL DEFAULT 10;