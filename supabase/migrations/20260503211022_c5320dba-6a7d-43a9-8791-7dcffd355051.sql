DO $$ BEGIN PERFORM cron.unschedule('placements-cleanup-daily'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('placements-cleanup-15d'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'placements-cleanup-15d',
  '0 6 */15 * *',
  $$
  SELECT net.http_post(
    url := 'https://xqpbkvlaxoswgwedscqf.supabase.co/functions/v1/placements-cleanup-cron',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb
  );
  $$
);

ALTER TABLE public.rules_config
  ALTER COLUMN placement_cleanup_min_days SET DEFAULT 15;