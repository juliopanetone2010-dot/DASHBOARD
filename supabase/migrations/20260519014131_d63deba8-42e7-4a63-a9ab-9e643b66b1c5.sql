
CREATE TABLE IF NOT EXISTS public.push_url_revenue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  site_id uuid,
  network_code text,
  date date NOT NULL,
  page_url text NOT NULL,
  utm_source text NOT NULL DEFAULT 'unknown',
  utm_campaign text NOT NULL DEFAULT 'unknown',
  revenue_usd numeric NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  ecpm numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS push_url_revenue_unique
  ON public.push_url_revenue (site_id, date, page_url, utm_source, utm_campaign);

CREATE INDEX IF NOT EXISTS push_url_revenue_user_date
  ON public.push_url_revenue (user_id, date);

CREATE INDEX IF NOT EXISTS push_url_revenue_site_utm
  ON public.push_url_revenue (site_id, utm_source, date);

ALTER TABLE public.push_url_revenue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own push url revenue"
  ON public.push_url_revenue
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
