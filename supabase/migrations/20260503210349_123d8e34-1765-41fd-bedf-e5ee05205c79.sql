ALTER TABLE public.rules_config
  ADD COLUMN IF NOT EXISTS placement_auto_cleanup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS placement_cleanup_min_days integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS placement_cleanup_max_roi_pct numeric NOT NULL DEFAULT -10,
  ADD COLUMN IF NOT EXISTS placement_cleanup_min_cost_brl numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS placement_cleanup_min_clicks integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS placement_cleanup_last_run_at timestamptz;

-- agenda diária (24h) em vez do antigo 15 dias
DO $$
BEGIN
  PERFORM cron.unschedule('placements-cleanup-biweekly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('placements-cleanup-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'placements-cleanup-daily',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://pxlgkpuaaptbubsnvfkz.supabase.co/functions/v1/placements-cleanup-cron',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb
  );
  $$
);