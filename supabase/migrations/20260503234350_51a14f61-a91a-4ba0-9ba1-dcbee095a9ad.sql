ALTER TABLE public.rules_config
  ADD COLUMN IF NOT EXISTS placement_cleanup_interval_days integer NOT NULL DEFAULT 15;