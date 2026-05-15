
-- ============ scale_unlock_state ============
CREATE TABLE public.scale_unlock_state (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  campaign_id text NOT NULL,
  google_account_id uuid,
  site_id uuid,
  status text NOT NULL DEFAULT 'idle',
  -- idle | candidate | unlocking | observing | scaling | learning_limited
  -- | budget_reduced | cpa_relaxed | unlock_failed | unlock_succeeded
  unlock_score numeric NOT NULL DEFAULT 0,
  unlock_confidence numeric NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  base_budget numeric,
  current_budget numeric,
  base_cpa numeric,
  current_cpa numeric,
  last_roi_pct numeric,
  last_delivery_rate numeric,
  last_ctr_pct numeric,
  last_action text,
  last_action_at timestamptz,
  observe_until timestamptz,
  cooldown_until timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  failed_at timestamptz,
  failed_reason text,
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_id)
);

CREATE INDEX idx_su_state_user ON public.scale_unlock_state(user_id);
CREATE INDEX idx_su_state_status ON public.scale_unlock_state(user_id, status);
CREATE INDEX idx_su_state_observe ON public.scale_unlock_state(observe_until);

ALTER TABLE public.scale_unlock_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own scale unlock state"
  ON public.scale_unlock_state FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_su_state_updated_at
  BEFORE UPDATE ON public.scale_unlock_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ scale_unlock_logs ============
CREATE TABLE public.scale_unlock_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  google_account_id uuid,
  site_id uuid,
  action text NOT NULL,
  -- reduce_budget | increase_budget | relax_cpa | tighten_cpa
  -- | start_observation | end_observation | mark_failed | mark_succeeded | skip
  reason text,
  status text NOT NULL DEFAULT 'executed', -- executed | dry_run | failed | skipped
  error text,
  old_budget numeric,
  new_budget numeric,
  old_cpa numeric,
  new_cpa numeric,
  roi_before numeric,
  roi_after numeric,
  delivery_before numeric,
  delivery_after numeric,
  unlock_score numeric,
  unlock_confidence numeric,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_su_logs_user ON public.scale_unlock_logs(user_id, created_at DESC);
CREATE INDEX idx_su_logs_campaign ON public.scale_unlock_logs(user_id, campaign_id, created_at DESC);

ALTER TABLE public.scale_unlock_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own scale unlock logs"
  ON public.scale_unlock_logs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============ scale_unlock_config ============
CREATE TABLE public.scale_unlock_config (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  dry_run boolean NOT NULL DEFAULT true,
  -- thresholds para detectar travamento
  min_roi_pct numeric NOT NULL DEFAULT -15,
  max_delivery_rate numeric NOT NULL DEFAULT 0.75,  -- < 75% = travada
  min_ctr_pct numeric NOT NULL DEFAULT 0.5,
  min_spend_brl numeric NOT NULL DEFAULT 20,
  min_conversions numeric NOT NULL DEFAULT 1,
  lookback_days integer NOT NULL DEFAULT 5,
  -- ações
  scale_pct numeric NOT NULL DEFAULT 20,           -- +20% budget
  reduce_budget_pct numeric NOT NULL DEFAULT 30,   -- novo budget = 30% do atual
  relax_cpa_pct numeric NOT NULL DEFAULT 15,       -- +15% no target_cpa
  scale_min_roi_pct numeric NOT NULL DEFAULT 20,
  scale_min_delivery numeric NOT NULL DEFAULT 0.9,
  -- janelas
  observation_hours integer NOT NULL DEFAULT 48,
  cooldown_hours integer NOT NULL DEFAULT 24,
  scale_interval_hours integer NOT NULL DEFAULT 48,
  fail_after_days integer NOT NULL DEFAULT 4,
  fail_max_roi numeric NOT NULL DEFAULT -30,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.scale_unlock_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own scale unlock config"
  ON public.scale_unlock_config FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_su_config_updated_at
  BEFORE UPDATE ON public.scale_unlock_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ Lock para outras engines respeitarem ============
ALTER TABLE public.campaign_automation
  ADD COLUMN IF NOT EXISTS scale_unlock_locked_until timestamptz;
ALTER TABLE public.campaign_funnel
  ADD COLUMN IF NOT EXISTS scale_unlock_locked_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_camp_auto_su_lock
  ON public.campaign_automation(scale_unlock_locked_until);
CREATE INDEX IF NOT EXISTS idx_camp_funnel_su_lock
  ON public.campaign_funnel(scale_unlock_locked_until);
