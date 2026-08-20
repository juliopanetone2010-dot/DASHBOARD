ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS sync_lock boolean DEFAULT false;
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS next_sync_allowed_at timestamp with time zone;