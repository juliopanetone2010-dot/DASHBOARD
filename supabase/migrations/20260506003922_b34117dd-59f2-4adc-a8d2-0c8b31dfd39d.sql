
-- Tabela principal de lifecycle do Funil Inteligente
CREATE TABLE IF NOT EXISTS public.campaign_funnel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid,
  google_account_id uuid,
  campaign_id text NOT NULL,
  campaign_name text,

  -- Lifecycle: learning | cpa-learning | scaling | advanced-scaling | failed-learning | paused | stable | graduated
  funnel_status text NOT NULL DEFAULT 'learning',
  entry_source text NOT NULL DEFAULT 'auto', -- auto | geo_winner | restart | manual
  entered_at timestamptz NOT NULL DEFAULT now(),

  -- Janelas
  learning_started_at timestamptz NOT NULL DEFAULT now(),
  cpa_learning_started_at timestamptz,
  scaling_started_at timestamptz,
  advanced_scaling_started_at timestamptz,
  stable_started_at timestamptz,
  graduated_at timestamptz,
  paused_at timestamptz,

  -- Estado financeiro/decis\u00f5es
  initial_budget numeric NOT NULL DEFAULT 30,
  current_budget numeric,
  applied_target_cpa numeric,
  avg_cpa_5d numeric,
  last_roi_pct numeric,
  last_delivery_rate numeric,
  consecutive_high_roi_days integer NOT NULL DEFAULT 0,
  bad_roi_days integer NOT NULL DEFAULT 0,

  -- Cooldowns
  last_scale_at timestamptz,
  last_cpa_change_at timestamptz,
  cooldown_scale_until timestamptz,
  cooldown_cpa_until timestamptz,

  -- Auditoria
  last_action text,
  last_action_reason text,
  last_evaluated_at timestamptz,
  next_action_hint text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_funnel_user ON public.campaign_funnel(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_funnel_site ON public.campaign_funnel(site_id);
CREATE INDEX IF NOT EXISTS idx_campaign_funnel_status ON public.campaign_funnel(funnel_status);
CREATE INDEX IF NOT EXISTS idx_campaign_funnel_campaign ON public.campaign_funnel(campaign_id);

ALTER TABLE public.campaign_funnel ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own funnel"
  ON public.campaign_funnel FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_campaign_funnel_updated
  BEFORE UPDATE ON public.campaign_funnel
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Logs de cada decis\u00e3o do Funil Inteligente
CREATE TABLE IF NOT EXISTS public.campaign_funnel_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  funnel_id uuid,
  campaign_id text NOT NULL,
  campaign_name text,
  site_id uuid,
  google_account_id uuid,
  status_from text,
  status_to text,
  action text NOT NULL, -- pause | enable | scale_up | cpa_up | cpa_down | switch_target_cpa | graduate | observe | none
  reason text,
  roi_pct numeric,
  delivery_rate numeric,
  avg_cpa numeric,
  budget_before numeric,
  budget_after numeric,
  cpa_before numeric,
  cpa_after numeric,
  dry_run boolean NOT NULL DEFAULT true,
  payload jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_funnel_logs_user ON public.campaign_funnel_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_funnel_logs_campaign ON public.campaign_funnel_logs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_funnel_logs_created ON public.campaign_funnel_logs(created_at DESC);

ALTER TABLE public.campaign_funnel_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own funnel logs"
  ON public.campaign_funnel_logs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Configura\u00e7\u00e3o por site da esteira inteligente
CREATE TABLE IF NOT EXISTS public.site_funnel_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  google_account_id uuid NOT NULL,
  funnel_enabled boolean NOT NULL DEFAULT false,
  funnel_dry_run boolean NOT NULL DEFAULT true,
  initial_budget numeric NOT NULL DEFAULT 30,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, site_id, google_account_id)
);

ALTER TABLE public.site_funnel_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own site funnel config"
  ON public.site_funnel_config FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_site_funnel_config_updated
  BEFORE UPDATE ON public.site_funnel_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Flag global em rules_config
ALTER TABLE public.rules_config
  ADD COLUMN IF NOT EXISTS funnel_smart_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS funnel_smart_last_run_at timestamptz;
