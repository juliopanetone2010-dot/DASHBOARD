ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS operational_status text,
  ADD COLUMN IF NOT EXISTS operational_status_at timestamptz,
  ADD COLUMN IF NOT EXISTS operational_status_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS operational_note text;

CREATE INDEX IF NOT EXISTS idx_campaigns_operational_status
  ON public.campaigns(user_id, operational_status)
  WHERE operational_status IS NOT NULL;