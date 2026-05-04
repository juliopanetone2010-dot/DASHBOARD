DELETE FROM public.campaign_automation ca
WHERE NOT EXISTS (
  SELECT 1 FROM public.gam_campaign_source_revenue g
  WHERE g.user_id = ca.user_id
    AND g.campaign_id = ca.campaign_id
    AND g.site_id IS NOT NULL
);