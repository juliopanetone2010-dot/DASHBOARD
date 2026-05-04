
CREATE TABLE public.placement_cleanup_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  site_id UUID,
  google_account_id UUID,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  placements_removed_count INTEGER NOT NULL DEFAULT 0,
  removed_placements JSONB,
  roi_before NUMERIC,
  cost_before NUMERIC,
  revenue_before NUMERIC,
  lookback_days INTEGER NOT NULL DEFAULT 3,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.placement_cleanup_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own placement cleanup logs"
ON public.placement_cleanup_logs
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_placement_cleanup_logs_user_site_exec
  ON public.placement_cleanup_logs (user_id, site_id, executed_at DESC);
CREATE INDEX idx_placement_cleanup_logs_campaign
  ON public.placement_cleanup_logs (campaign_id);
