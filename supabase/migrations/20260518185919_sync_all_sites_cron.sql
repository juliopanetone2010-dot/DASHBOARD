-- Schedule the background dashboard auto-refresh.
--
-- Before this migration the operator had to click "Atualizar" on the
-- dashboard to pull fresh Google Ads + GAM data — a 5-30s blocking call
-- that's easy to forget. This schedules the new sync-all-sites-cron edge
-- function to run every 20 minutes, which iterates active sites and
-- triggers site-auto-onboard for each (with per-site 15-min skip logic
-- to respect API quotas).
--
-- Pattern: identical to the existing campaign-restart-daily-tick job.
-- pg_cron + net.http_post is the in-repo idiom for "call an edge function
-- on a schedule".

-- Idempotency: if a previous version of this job exists (different schedule,
-- different name typo), unschedule it before scheduling the new one.
DO $$
BEGIN
  PERFORM cron.unschedule('sync-all-sites-every-20min');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

SELECT cron.schedule(
  'sync-all-sites-every-20min',
  '*/20 * * * *',  -- every 20 minutes
  $$
  SELECT net.http_post(
    url := 'https://pxlgkpuaaptbubsnvfkz.supabase.co/functions/v1/sync-all-sites-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('min_interval_min', 15)
  ) AS request_id;
  $$
);
