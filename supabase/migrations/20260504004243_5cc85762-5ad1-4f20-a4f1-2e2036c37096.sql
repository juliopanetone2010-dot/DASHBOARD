
-- ============ rules_config: novos campos ============
ALTER TABLE public.rules_config
  ADD COLUMN IF NOT EXISTS automation_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS automation_dry_run boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS automation_last_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_analysis_days integer NOT NULL DEFAULT 7,
  -- Stop loss
  ADD COLUMN IF NOT EXISTS auto_stoploss_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS auto_stoploss_min_roi numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_stoploss_min_cost numeric NOT NULL DEFAULT 10,
  -- Escala
  ADD COLUMN IF NOT EXISTS auto_scale_min_roi numeric NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS auto_scale_budget_pct numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS auto_scale_interval_days integer NOT NULL DEFAULT 2,
  -- CPA
  ADD COLUMN IF NOT EXISTS auto_cpa_up_pct numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS auto_cpa_down_pct numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS auto_cpa_review_days integer NOT NULL DEFAULT 5,
  -- Standby
  ADD COLUMN IF NOT EXISTS auto_standby_roi_low numeric NOT NULL DEFAULT -10,
  ADD COLUMN IF NOT EXISTS auto_standby_roi_high numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS auto_standby_enter_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS auto_standby_max_days integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS auto_standby_exit_roi numeric NOT NULL DEFAULT 30;

-- ============ campaign_automation ============
CREATE TABLE IF NOT EXISTS public.campaign_automation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  campaign_id text NOT NULL,
  google_account_id uuid,
  lifecycle_status text NOT NULL DEFAULT 'testing',
  last_action text,
  last_action_date timestamptz,
  last_scale_date timestamptz,
  last_cpa_action text,
  last_cpa_action_date timestamptz,
  cooldown_until timestamptz,
  last_roi numeric,
  roi_trend text,
  entered_standby_at timestamptz,
  days_in_standby integer NOT NULL DEFAULT 0,
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_id)
);

ALTER TABLE public.campaign_automation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own campaign automation"
  ON public.campaign_automation FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_campaign_automation_user ON public.campaign_automation(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_automation_status ON public.campaign_automation(user_id, lifecycle_status);

CREATE TRIGGER trg_campaign_automation_updated
  BEFORE UPDATE ON public.campaign_automation
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ automation_logs ============
CREATE TABLE IF NOT EXISTS public.automation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  campaign_id text NOT NULL,
  action text NOT NULL,           -- pause | scale | cpa_up | cpa_down | standby_enter | standby_exit | classify | skip
  reason text,
  decision text,                  -- executed | dry_run | skipped | failed
  roi numeric,
  cost numeric,
  revenue numeric,
  lifecycle_from text,
  lifecycle_to text,
  payload jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.automation_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own automation logs"
  ON public.automation_logs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_automation_logs_user_created ON public.automation_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_logs_campaign ON public.automation_logs(user_id, campaign_id, created_at DESC);
