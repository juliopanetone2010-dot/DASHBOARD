
UPDATE public.daily_metrics dm
SET 
  revenue = sub.total_rev,
  profit = (sub.total_rev * 5.15) - dm.spend,
  roi = CASE WHEN dm.spend > 0 THEN (((sub.total_rev * 5.15) - dm.spend) / dm.spend) * 100 ELSE 0 END
FROM (
  SELECT campaign_id, date, user_id, sum(revenue_usd) as total_rev
  FROM public.gam_campaign_source_revenue
  WHERE date >= '2026-08-20'
  GROUP BY campaign_id, date, user_id
) sub
WHERE dm.campaign_id = sub.campaign_id 
  AND dm.date = sub.date 
  AND dm.user_id = sub.user_id
  AND dm.date >= '2026-08-20';
