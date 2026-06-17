DELETE FROM public.gam_campaign_source_revenue
WHERE site_id = '28404d69-ba48-432c-ae7c-2610f79ab81f'
  AND campaign_id = '__aggregate__'
  AND utm_source = 'push'
  AND date = '2026-06-17';

INSERT INTO public.gam_campaign_source_revenue (user_id, site_id, campaign_id, date, utm_source, revenue_usd, impressions)
SELECT user_id, site_id, '__aggregate__', date, 'push', revenue_usd, impressions
FROM public.unattributed_push_revenue
WHERE site_id = '28404d69-ba48-432c-ae7c-2610f79ab81f'
  AND date = '2026-06-17';