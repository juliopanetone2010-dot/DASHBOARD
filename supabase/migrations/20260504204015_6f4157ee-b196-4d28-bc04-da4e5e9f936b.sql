-- Agenda diária do tick do fluxo de reinício
SELECT cron.schedule(
  'campaign-restart-daily-tick',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://pxlgkpuaaptbubsnvfkz.supabase.co/functions/v1/campaign-restart',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('action', 'tick')
  ) AS request_id;
  $$
);
