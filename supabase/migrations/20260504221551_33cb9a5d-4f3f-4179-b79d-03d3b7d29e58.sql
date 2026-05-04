ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS sync_error text,
  ADD COLUMN IF NOT EXISTS sync_started_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_full_sync_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_sites_sync_status ON public.sites(sync_status);