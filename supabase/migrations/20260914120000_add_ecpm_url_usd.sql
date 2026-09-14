-- eCPM real por URL/página (fallback do eCPM da campanha quando a atribuição por
-- utm_campaign não é confiável). Ver supabase/functions/gam-sync-revenue/index.ts
-- (fetchUrlEcpm / pickUrlEcpm) e src/pages/Index.tsx (campaignGamMetricsQuery).
ALTER TABLE public.gam_campaign_source_revenue
  ADD COLUMN IF NOT EXISTS ecpm_url_usd numeric;
