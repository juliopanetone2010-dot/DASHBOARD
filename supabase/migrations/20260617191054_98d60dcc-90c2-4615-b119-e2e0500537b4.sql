DELETE FROM public.gam_campaign_source_revenue
WHERE site_id = 'e88d67f1-5e43-47b4-ac4b-beb0555634fb'
  AND campaign_id = '__aggregate__'
  AND utm_source = 'push'
  AND date = '2026-06-17';

INSERT INTO public.gam_campaign_source_revenue (user_id, site_id, campaign_id, date, utm_source, revenue_usd, impressions)
SELECT user_id, site_id, '__aggregate__', date, 'push', revenue_usd, impressions
FROM public.unattributed_push_revenue
WHERE site_id = 'e88d67f1-5e43-47b4-ac4b-beb0555634fb'
  AND date = '2026-06-17';