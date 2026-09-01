-- Sincronização periódica de receita / gasto / taxa de correspondência.
--
-- Até agora o único caminho que atualizava gam_campaign_source_revenue,
-- daily_metrics e match_rate_pct era:
--   1) o usuário abrir o dashboard (dispara site-auto-onboard), ou
--   2) o auto-sync do front quando a Taxa de Correspondência vinha vazia.
-- Sem ninguém com o dashboard aberto, os dados ficavam parados o dia inteiro.
--
-- sites-sync-cron já existe e foi feito para isto ("Roda a cada 15 min via
-- pg_cron"): pega todo site cujo last_full_sync_at é > 30 min e chama
-- site-auto-onboard (Google Ads + gam-sync-revenue + snapshots). Ele mesmo
-- pula sites que sincronizaram há pouco, então rodar a cada 30 min é seguro.
--
-- Auth: mesmo padrão de 20260831190000_cron_auth_via_vault.sql — bearer do
-- service_role guardado no Vault (secret 'service_role_key', criado fora do
-- versionamento).

DO $$ BEGIN PERFORM cron.unschedule('periodic-revenue-sync-30m'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'periodic-revenue-sync-30m',
  '*/30 * * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://xqpbkvlaxoswgwedscqf.supabase.co/functions/v1/sites-sync-cron',
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
