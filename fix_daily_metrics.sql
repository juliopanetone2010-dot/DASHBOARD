-- We use a single batch update to minimize permission errors or trigger issues
UPDATE public.daily_metrics dm
SET 
  revenue = sub.total_revenue_usd,
  profit = (sub.total_revenue_usd * 5.204) - dm.spend,
  roi = CASE WHEN dm.spend > 0 THEN (((sub.total_revenue_usd * 5.204) - dm.spend) / dm.spend) * 100 ELSE 0 END,
  roas = CASE WHEN dm.spend > 0 THEN (sub.total_revenue_usd * 5.204) / dm.spend ELSE 0 END,
  ecpm = CASE WHEN dm.impressions > 0 THEN ((sub.total_revenue_usd * 5.204) / dm.impressions) * 1000 ELSE 0 END
FROM (
    SELECT campaign_id, sum(revenue_usd) as total_revenue_usd
    FROM public.gam_campaign_source_revenue
    WHERE site_id = '28404d69-ba48-432c-ae7c-2610f79ab81f'
      AND date = '2026-08-19'
    GROUP BY campaign_id
) AS sub
JOIN public.campaigns c ON sub.campaign_id = c.campaign_id
JOIN public.account_site_links asl ON c.google_account_id = asl.google_account_id
WHERE dm.campaign_id = sub.campaign_id
  AND dm.date = '2026-08-19'
  AND asl.site_id = '28404d69-ba48-432c-ae7c-2610f79ab81f';
