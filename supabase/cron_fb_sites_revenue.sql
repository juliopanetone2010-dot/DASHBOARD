-- 11/10/2026: receita por campanha (utm_campaign) + eCPM da URL dos sites do Facebook (Lucrando e Ligado 360).
-- O sites-sync-cron roda o gam-sync-revenue em modo revenue_only, que não regrava gam_campaign_source_revenue desses sites;
-- a aba Facebook ficava com a receita de horas atrás. Roda de hora em hora (minuto 20), de ontem até hoje.
select cron.schedule('fb-sites-revenue-hourly', '20 * * * *', $cron$
  select net.http_post(
    url := 'https://xqpbkvlaxoswgwedscqf.supabase.co/functions/v1/gam-sync-revenue',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'), current_setting('app.settings.service_role_key', true))),
    body := jsonb_build_object('user_id','c3e78d8c-c321-44f1-bed2-176f940ae3f1','site_id', s.site_id,
      'from', to_char((now() at time zone 'America/Sao_Paulo')::date - 1, 'YYYY-MM-DD'),
      'to', to_char((now() at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD'),
      'skip_legacy_reports', true),
    timeout_milliseconds := 60000)
  from (values ('9011db8e-cd6c-4b9f-931c-3a5973daf00e'), ('13e49615-21e1-4351-8a7f-545348def355')) as s(site_id);
$cron$);
