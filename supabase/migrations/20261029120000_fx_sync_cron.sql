-- Atualiza exchange_rates (USD/EUR/GBP -> BRL) a cada 30 min, mesmo com a dash fechada.
-- No servidor a fx-sync usa AwesomeAPI -> PTAX do Banco Central -> open.er-api.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('fx-sync-30min');
EXCEPTION WHEN OTHERS THEN
  NULL; -- job ainda nao existe
END $$;

SELECT cron.schedule(
  'fx-sync-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xqpbkvlaxoswgwedscqf.supabase.co/functions/v1/fx-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  $$
);
