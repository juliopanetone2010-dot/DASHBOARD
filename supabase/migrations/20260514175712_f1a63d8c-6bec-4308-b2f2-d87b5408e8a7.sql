ALTER TABLE public.campaign_automation
  ADD COLUMN IF NOT EXISTS auto_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_paused_reason text,
  ADD COLUMN IF NOT EXISTS auto_pause_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_pause_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS auto_pause_state text,
  ADD COLUMN IF NOT EXISTS auto_pause_resume_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_pause_resumed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_campaign_automation_auto_pause_state
  ON public.campaign_automation (auto_pause_state)
  WHERE auto_pause_state IS NOT NULL;