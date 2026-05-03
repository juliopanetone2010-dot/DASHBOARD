CREATE TABLE IF NOT EXISTS public.gam_campaign_source_revenue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  site_id uuid,
  campaign_id text NOT NULL,
  date date NOT NULL,
  utm_source text NOT NULL,
  revenue_usd numeric NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gam_campaign_source_revenue_unique
  ON public.gam_campaign_source_revenue (user_id, site_id, campaign_id, date, utm_source);

CREATE INDEX IF NOT EXISTS gam_campaign_source_revenue_lookup
  ON public.gam_campaign_source_revenue (user_id, date, utm_source);

ALTER TABLE public.gam_campaign_source_revenue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own gam campaign source revenue"
  ON public.gam_campaign_source_revenue
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);