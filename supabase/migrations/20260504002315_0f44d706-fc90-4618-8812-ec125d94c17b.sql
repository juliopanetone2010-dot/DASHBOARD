ALTER TABLE public.rules_config 
ADD COLUMN IF NOT EXISTS funnel_auto_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS funnel_auto_interval_days integer NOT NULL DEFAULT 15,
ADD COLUMN IF NOT EXISTS funnel_auto_last_run_at timestamp with time zone;