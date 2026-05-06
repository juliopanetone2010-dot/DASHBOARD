
CREATE TABLE public.daily_financial_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  date date NOT NULL,
  google_ads_cost numeric NOT NULL DEFAULT 0,
  facebook_ads_cost numeric NOT NULL DEFAULT 0,
  other_cost numeric NOT NULL DEFAULT 0,
  total_cost numeric NOT NULL DEFAULT 0,
  gross_revenue numeric NOT NULL DEFAULT 0,
  net_revenue numeric NOT NULL DEFAULT 0,
  adsense_revenue numeric,
  adx_revenue numeric,
  revenue_after_revshare numeric NOT NULL DEFAULT 0,
  taxes numeric NOT NULL DEFAULT 0,
  fixed_cost numeric NOT NULL DEFAULT 0,
  liquid_profit numeric NOT NULL DEFAULT 0,
  profit_margin_pct numeric NOT NULL DEFAULT 0,
  ecpm numeric NOT NULL DEFAULT 0,
  viewability numeric NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  conversions numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'BRL',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, site_id, date)
);

CREATE INDEX idx_dfs_site_date ON public.daily_financial_snapshots(site_id, date DESC);
CREATE INDEX idx_dfs_user_date ON public.daily_financial_snapshots(user_id, date DESC);

ALTER TABLE public.daily_financial_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own financial snapshots"
ON public.daily_financial_snapshots
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
