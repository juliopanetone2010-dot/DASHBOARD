DELETE FROM public.gam_campaign_source_revenue
WHERE campaign_id = '__aggregate__'
  AND utm_source = 'push'
  AND date = '2026-06-17'
  AND site_id IN (
    SELECT site_id FROM public.unattributed_push_revenue WHERE date = '2026-06-17'
  );

INSERT INTO public.gam_campaign_source_revenue (user_id, site_id, campaign_id, date, utm_source, revenue_usd, impressions)
SELECT user_id, site_id, '__aggregate__', date, 'push', revenue_usd, impressions
FROM public.unattributed_push_revenue
WHERE date = '2026-06-17';