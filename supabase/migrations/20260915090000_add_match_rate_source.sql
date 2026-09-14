-- Rastreia DE ONDE veio o match_rate_pct de cada linha, pra expor na UI (badge no
-- CampaignsTable) sem precisar ler log do Supabase pra saber se é a taxa REAL do
-- GAM por campanha, um proxy calibrado, por URL, do site inteiro, ou por cliques.
-- Ver supabase/functions/gam-sync-revenue/index.ts (persistCampaignTotalRequests /
-- recomputeCampaignMatchRateFromClicks).
ALTER TABLE public.gam_campaign_source_revenue
  ADD COLUMN IF NOT EXISTS match_rate_source text;
