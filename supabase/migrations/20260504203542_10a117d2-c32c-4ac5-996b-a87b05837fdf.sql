CREATE TABLE public.campaign_restart_flow (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  campaign_id text NOT NULL,
  site_id uuid,
  google_account_id uuid,
  stage text NOT NULL DEFAULT 'restart_testing_day_0',
  status text NOT NULL DEFAULT 'active', -- active | paused | recovered | failed
  start_date timestamptz NOT NULL DEFAULT now(),
  last_action text,
  last_action_at timestamptz,
  initial_budget numeric DEFAULT 40,
  current_budget numeric,
  roi numeric,
  delivery_ratio numeric,
  avg_cpa numeric,
  applied_cpa numeric,
  phase2_started_at timestamptz,
  phase3_started_at timestamptz,
  phase4_started_at timestamptz,
  finished_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX campaign_restart_flow_active_uq
  ON public.campaign_restart_flow(user_id, campaign_id)
  WHERE status = 'active';

CREATE INDEX campaign_restart_flow_user_idx ON public.campaign_restart_flow(user_id);
CREATE INDEX campaign_restart_flow_status_idx ON public.campaign_restart_flow(status);

ALTER TABLE public.campaign_restart_flow ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own restart flow"
  ON public.campaign_restart_flow
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_restart_flow_updated_at
  BEFORE UPDATE ON public.campaign_restart_flow
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
