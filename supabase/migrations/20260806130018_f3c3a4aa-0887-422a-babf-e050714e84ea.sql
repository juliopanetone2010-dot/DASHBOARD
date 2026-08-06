ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS final_url_suffix text,
  ADD COLUMN IF NOT EXISTS utm_applied_at timestamptz;