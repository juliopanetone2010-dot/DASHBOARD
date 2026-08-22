UPDATE public.daily_metrics dm
SET revenue = subquery.total_revenue
FROM (
    SELECT campaign_id, sum(revenue_usd) as total_revenue
    FROM public.gam_campaign_source_revenue
    WHERE site_id = '28404d69-ba48-432c-ae7c-2610f79ab81f'
      AND date = '2026-08-19'
    GROUP BY campaign_id
) AS subquery
WHERE dm.campaign_id = subquery.campaign_id
  AND dm.date = '2026-08-19';
