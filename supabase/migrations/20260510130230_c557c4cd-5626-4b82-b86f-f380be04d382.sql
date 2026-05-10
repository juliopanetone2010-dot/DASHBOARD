ALTER TABLE public.campaign_automation
  ADD COLUMN IF NOT EXISTS second_chance_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS second_chance_reason text;