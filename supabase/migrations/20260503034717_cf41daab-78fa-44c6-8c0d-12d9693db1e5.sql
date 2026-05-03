
ALTER TABLE public.ads_placements
  ADD COLUMN IF NOT EXISTS placement_clean text;

CREATE INDEX IF NOT EXISTS ads_placements_clean_idx
  ON public.ads_placements (user_id, campaign_id, placement_clean);

CREATE TABLE IF NOT EXISTS public.gam_placement_revenue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  site_id uuid,
  campaign_id text NOT NULL,
  placement text NOT NULL,
  date date NOT NULL,
  revenue_usd numeric NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign_id, placement, date)
);

CREATE INDEX IF NOT EXISTS gam_placement_revenue_lookup_idx
  ON public.gam_placement_revenue (user_id, campaign_id, placement);

ALTER TABLE public.gam_placement_revenue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own gam placement revenue"
  ON public.gam_placement_revenue FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
