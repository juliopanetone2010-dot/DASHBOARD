ALTER TABLE public.rules_config
ADD COLUMN IF NOT EXISTS revenue_share_pct numeric NOT NULL DEFAULT 6.5;