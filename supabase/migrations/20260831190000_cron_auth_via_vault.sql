-- Cron -> Edge Function auth.
--
-- The historical cron jobs authenticate with
--   current_setting('app.settings.service_role_key', true)
-- but on a standard Supabase project that GUC is not writable by the `postgres`
-- role, so it resolves to NULL and every scheduled call is rejected with 401.
--
-- Fix: keep the service-role bearer token in Vault and read it from there.
-- The secret VALUE is created out of band (never committed). Run ONCE in the
-- Supabase SQL editor after deploy:
--
--   select vault.create_secret(
--     '<SUPABASE_SERVICE_ROLE_KEY>',            -- legacy service_role JWT (eyJ...)
--     'service_role_key',
--     'Bearer token used by pg_cron to call edge functions'
--   );
--
-- Rotate later:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'service_role_key'), '<NEW_KEY>');

DO $$ BEGIN PERFORM cron.unschedule('campaign-restart-daily-tick'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('placements-cleanup-15d'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'campaign-restart-daily-tick',
  '0 6 * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://xqpbkvlaxoswgwedscqf.supabase.co/functions/v1/campaign-restart',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        current_setting('app.settings.service_role_key', true)
      )
    ),
    body := jsonb_build_object('action', 'tick')
  );
  $CRON$
);

SELECT cron.schedule(
  'placements-cleanup-15d',
  '0 6 */15 * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://xqpbkvlaxoswgwedscqf.supabase.co/functions/v1/placements-cleanup-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        current_setting('app.settings.service_role_key', true)
      )
    ),
    body := '{}'::jsonb
  );
  $CRON$
);
