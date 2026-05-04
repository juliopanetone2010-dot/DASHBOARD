ALTER TABLE public.campaign_automation
  ADD COLUMN IF NOT EXISTS delivery_ratio numeric,
  ADD COLUMN IF NOT EXISTS daily_budget numeric,
  ADD COLUMN IF NOT EXISTS last_delivery_action text,
  ADD COLUMN IF NOT EXISTS last_delivery_action_date timestamptz;