-- Soft pause / auto-revert support for campaign_automation.
--
-- When the automation engine pauses a campaign, we record:
--   - auto_paused_at         : when the pause happened (server now())
--   - auto_paused_reason     : the human-readable reason from the engine
--   - auto_pause_review_at   : when the campaign becomes eligible for review
--                              (typically auto_paused_at + 48h)
--   - auto_pause_snapshot    : metrics at decision time (roi, trend, delivery, …)
--   - auto_pause_state       : 'pending_review' | 'auto_resumed' |
--                              'exhausted_auto' | 'human_confirmed' | NULL
--   - auto_pause_resume_count: how many times the engine has already auto-
--                              resumed this campaign (capped at 1 in v1 to
--                              prevent thrash)
--   - auto_pause_resumed_at  : when the auto-resume happened (if any)
--
-- The columns are NULL for any campaign the engine has never paused;
-- manually paused campaigns are NOT touched by the auto-revert flow.

ALTER TABLE public.campaign_automation
  ADD COLUMN IF NOT EXISTS auto_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS auto_pause_review_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_pause_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS auto_pause_state TEXT,
  ADD COLUMN IF NOT EXISTS auto_pause_resume_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_pause_resumed_at TIMESTAMPTZ;

-- Partial index for the per-run "find campaigns due for review" query.
-- Only indexes rows we actually scan, keeps the index small.
CREATE INDEX IF NOT EXISTS idx_campaign_automation_pending_review
  ON public.campaign_automation (user_id, site_id, google_account_id, auto_pause_review_at)
  WHERE auto_pause_state = 'pending_review';
