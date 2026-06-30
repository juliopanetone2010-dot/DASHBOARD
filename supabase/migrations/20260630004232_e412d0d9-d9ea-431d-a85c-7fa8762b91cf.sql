DELETE FROM public.daily_financial_snapshots
WHERE date > (now() AT TIME ZONE 'America/Sao_Paulo')::date
  AND COALESCE(gross_revenue,0) = 0
  AND COALESCE(impressions,0) = 0;