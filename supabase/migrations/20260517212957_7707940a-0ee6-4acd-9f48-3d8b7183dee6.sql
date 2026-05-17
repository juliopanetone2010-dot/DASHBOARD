
CREATE TABLE public.gam_url_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid,
  url text NOT NULL,
  utm_source text,
  date date NOT NULL,
  revenue_usd numeric NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, site_id, url, date)
);

CREATE INDEX gam_url_revenue_user_date_idx ON public.gam_url_revenue (user_id, date DESC);
CREATE INDEX gam_url_revenue_utm_idx ON public.gam_url_revenue (user_id, utm_source, date);

ALTER TABLE public.gam_url_revenue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own gam url revenue"
  ON public.gam_url_revenue
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
