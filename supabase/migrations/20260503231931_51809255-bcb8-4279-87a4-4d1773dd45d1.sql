
CREATE TABLE public.placement_status (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  google_account_id uuid,
  campaign_id text NOT NULL,
  campaign_name text,
  placement text NOT NULL,
  placement_type text,
  app_id text,
  status text NOT NULL DEFAULT 'test',
  phase text NOT NULL DEFAULT 'phase1_test',
  reason text,
  manual_override boolean NOT NULL DEFAULT false,
  priority boolean NOT NULL DEFAULT false,
  cost_total numeric NOT NULL DEFAULT 0,
  revenue_total numeric NOT NULL DEFAULT 0,
  profit_total numeric NOT NULL DEFAULT 0,
  roi_pct numeric NOT NULL DEFAULT 0,
  clicks_total bigint NOT NULL DEFAULT 0,
  impressions_total bigint NOT NULL DEFAULT 0,
  conversions_total numeric NOT NULL DEFAULT 0,
  prev_roi_pct numeric,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  last_status_change_at timestamptz NOT NULL DEFAULT now(),
  blocked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT placement_status_uq UNIQUE (user_id, campaign_id, placement)
);

ALTER TABLE public.placement_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own placement status" ON public.placement_status
FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_placement_status_user_campaign ON public.placement_status(user_id, campaign_id);
CREATE INDEX idx_placement_status_status ON public.placement_status(user_id, status);

CREATE TRIGGER trg_placement_status_updated_at
BEFORE UPDATE ON public.placement_status
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.placement_status_history (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  placement_status_id uuid NOT NULL,
  campaign_id text NOT NULL,
  placement text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text,
  cost_total numeric,
  revenue_total numeric,
  roi_pct numeric,
  triggered_by text NOT NULL DEFAULT 'auto',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.placement_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own placement history" ON public.placement_status_history
FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_placement_status_hist_status ON public.placement_status_history(placement_status_id, created_at DESC);

ALTER TABLE public.rules_config
  ADD COLUMN IF NOT EXISTS funnel_test_max_cost numeric NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS funnel_learning_max_cost numeric NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS funnel_learning_min_roi numeric NOT NULL DEFAULT -40,
  ADD COLUMN IF NOT EXISTS funnel_decision_good_roi numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS funnel_decision_bad_roi numeric NOT NULL DEFAULT -20,
  ADD COLUMN IF NOT EXISTS funnel_block_min_cost numeric NOT NULL DEFAULT 150,
  ADD COLUMN IF NOT EXISTS funnel_block_max_roi numeric NOT NULL DEFAULT -30,
  ADD COLUMN IF NOT EXISTS funnel_scale_min_roi numeric NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS funnel_protect_min_clicks integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS funnel_protect_recent_conv_days integer NOT NULL DEFAULT 3;
