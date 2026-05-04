CREATE TABLE IF NOT EXISTS public.site_placement_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  google_account_id uuid NOT NULL,
  automation_enabled boolean NOT NULL DEFAULT false,
  automation_dry_run boolean NOT NULL DEFAULT true,
  interval_days integer NOT NULL DEFAULT 15,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS site_placement_config_unique
  ON public.site_placement_config (user_id, site_id, google_account_id);

ALTER TABLE public.site_placement_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own site placement config"
  ON public.site_placement_config FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER set_updated_at_site_placement_config
  BEFORE UPDATE ON public.site_placement_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.placement_status
  ADD COLUMN IF NOT EXISTS site_id uuid;
ALTER TABLE public.placement_status_history
  ADD COLUMN IF NOT EXISTS site_id uuid;

CREATE INDEX IF NOT EXISTS placement_status_site_idx
  ON public.placement_status (user_id, site_id, campaign_id);
CREATE INDEX IF NOT EXISTS placement_status_history_site_idx
  ON public.placement_status_history (user_id, site_id, campaign_id);