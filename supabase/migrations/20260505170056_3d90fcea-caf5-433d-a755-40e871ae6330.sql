
ALTER TABLE public.campaign_automation
  ADD COLUMN IF NOT EXISTS scaling_since timestamp with time zone,
  ADD COLUMN IF NOT EXISTS sub_threshold_days integer NOT NULL DEFAULT 0;
