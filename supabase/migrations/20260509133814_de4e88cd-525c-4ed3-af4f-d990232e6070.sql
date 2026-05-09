
-- Enable extensions for background jobs (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Sync state tracking
CREATE TABLE IF NOT EXISTS public.sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source text NOT NULL,
  google_account_id uuid,
  site_id uuid,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text NOT NULL DEFAULT 'idle',
  last_error text,
  rows_synced integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_state_user_source ON public.sync_state (user_id, source);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_state_scope
  ON public.sync_state (user_id, source, COALESCE(google_account_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own sync state"
  ON public.sync_state
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER sync_state_set_updated_at
  BEFORE UPDATE ON public.sync_state
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
