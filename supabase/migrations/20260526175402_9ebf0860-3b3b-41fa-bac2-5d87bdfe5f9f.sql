
CREATE TABLE public.push_retention_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  date date NOT NULL,
  url text NOT NULL,
  normalized_url text NOT NULL,
  utm_source text NOT NULL DEFAULT 'push',
  revenue_usd numeric NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  ecpm numeric NOT NULL DEFAULT 0,
  source text,
  raw_gam_row jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_retention_unique UNIQUE (site_id, date, normalized_url)
);

CREATE INDEX idx_push_retention_site_date ON public.push_retention_revenue (site_id, date DESC);
CREATE INDEX idx_push_retention_user ON public.push_retention_revenue (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_retention_revenue TO authenticated;
GRANT ALL ON public.push_retention_revenue TO service_role;

ALTER TABLE public.push_retention_revenue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner manage push retention"
  ON public.push_retention_revenue FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin granted push retention read"
  ON public.push_retention_revenue FOR SELECT TO authenticated
  USING (public.can_access_site(auth.uid(), site_id));

CREATE TRIGGER trg_push_retention_updated
  BEFORE UPDATE ON public.push_retention_revenue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.unattributed_push_revenue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  date date NOT NULL,
  revenue_usd numeric NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT 'aggregate',
  raw_gam_row jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unattributed_push_unique UNIQUE (site_id, date, reason)
);

CREATE INDEX idx_unattributed_push_site_date ON public.unattributed_push_revenue (site_id, date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.unattributed_push_revenue TO authenticated;
GRANT ALL ON public.unattributed_push_revenue TO service_role;

ALTER TABLE public.unattributed_push_revenue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner manage unattributed push"
  ON public.unattributed_push_revenue FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin granted unattributed push read"
  ON public.unattributed_push_revenue FOR SELECT TO authenticated
  USING (public.can_access_site(auth.uid(), site_id));

CREATE TRIGGER trg_unattributed_push_updated
  BEFORE UPDATE ON public.unattributed_push_revenue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
