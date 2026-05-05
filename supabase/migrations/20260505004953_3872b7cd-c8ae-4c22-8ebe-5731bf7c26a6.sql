ALTER TABLE public.placement_status
  ADD COLUMN IF NOT EXISTS site_scope text NOT NULL DEFAULT '__global__';

UPDATE public.placement_status
SET site_scope = COALESCE(site_id::text, '__global__')
WHERE site_scope = '__global__'
  AND site_id IS NOT NULL;

ALTER TABLE public.placement_status
  DROP CONSTRAINT IF EXISTS placement_status_uq;

ALTER TABLE public.placement_status
  ADD CONSTRAINT placement_status_site_scope_uq UNIQUE (user_id, site_scope, campaign_id, placement);

CREATE INDEX IF NOT EXISTS placement_status_site_scope_idx
  ON public.placement_status (user_id, site_scope, campaign_id);
