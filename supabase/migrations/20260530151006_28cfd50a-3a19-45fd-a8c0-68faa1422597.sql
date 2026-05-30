ALTER TABLE public.push_retention_revenue DROP CONSTRAINT IF EXISTS push_retention_unique;
ALTER TABLE public.push_retention_revenue ALTER COLUMN utm_source DROP DEFAULT;
ALTER TABLE public.push_retention_revenue ADD CONSTRAINT push_retention_unique UNIQUE (site_id, date, normalized_url, utm_source);
CREATE INDEX IF NOT EXISTS idx_push_retention_utm ON public.push_retention_revenue (site_id, utm_source, date DESC);