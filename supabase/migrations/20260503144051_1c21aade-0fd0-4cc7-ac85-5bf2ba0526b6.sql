ALTER TABLE public.gam_placement_revenue
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS raw_utm text;

CREATE INDEX IF NOT EXISTS gam_placement_revenue_source_idx
  ON public.gam_placement_revenue (user_id, utm_source, date);