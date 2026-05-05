WITH src AS (
  SELECT campaign_id, date, user_id, SUM(revenue_usd) AS rev_usd
  FROM gam_campaign_source_revenue
  GROUP BY campaign_id, date, user_id
),
plc AS (
  SELECT campaign_id, date, user_id, SUM(revenue_usd) AS rev_usd
  FROM gam_placement_revenue
  GROUP BY campaign_id, date, user_id
),
agg AS (
  SELECT dm.id,
         COALESCE(src.rev_usd, plc.rev_usd, 0) AS rev_usd,
         (SELECT rate FROM exchange_rates WHERE from_currency='USD' AND to_currency='BRL' LIMIT 1) AS fx,
         dm.spend, dm.impressions
  FROM daily_metrics dm
  LEFT JOIN src ON src.campaign_id = dm.campaign_id AND src.date = dm.date AND src.user_id = dm.user_id
  LEFT JOIN plc ON plc.campaign_id = dm.campaign_id AND plc.date = dm.date AND plc.user_id = dm.user_id
  WHERE dm.date >= CURRENT_DATE - INTERVAL '30 days'
)
UPDATE daily_metrics dm
SET revenue = a.rev_usd,
    profit = (a.rev_usd * a.fx) - a.spend,
    roi = CASE WHEN a.spend > 0 THEN (((a.rev_usd * a.fx) - a.spend) / a.spend) * 100 ELSE 0 END,
    roas = CASE WHEN a.spend > 0 THEN (a.rev_usd * a.fx) / a.spend ELSE 0 END,
    ecpm = CASE WHEN a.impressions > 0 THEN ((a.rev_usd * a.fx) / a.impressions) * 1000 ELSE 0 END,
    updated_at = now()
FROM agg a
WHERE a.id = dm.id;