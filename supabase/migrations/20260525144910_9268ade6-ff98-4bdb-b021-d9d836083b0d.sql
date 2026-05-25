
CREATE TABLE IF NOT EXISTS public.placement_revenue_reconciled (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid,
  google_account_id uuid,
  canonical_key text NOT NULL,
  campaign_id text NOT NULL,
  placement text NOT NULL,
  normalized_placement text NOT NULL,
  date date NOT NULL,
  revenue_usd numeric NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  ecpm numeric,
  clicks bigint NOT NULL DEFAULT 0,
  confidence integer NOT NULL DEFAULT 0,
  reconciliation_method text NOT NULL DEFAULT 'unknown',
  source_row jsonb,
  broken_tracking boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, canonical_key, date)
);

CREATE INDEX IF NOT EXISTS idx_prr_user_campaign_date ON public.placement_revenue_reconciled (user_id, campaign_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_prr_method ON public.placement_revenue_reconciled (reconciliation_method);
CREATE INDEX IF NOT EXISTS idx_prr_site_date ON public.placement_revenue_reconciled (site_id, date DESC);

ALTER TABLE public.placement_revenue_reconciled ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own reconciled rows" ON public.placement_revenue_reconciled
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin granted reconciled read" ON public.placement_revenue_reconciled
  FOR SELECT TO authenticated
  USING (public.can_access_site(auth.uid(), site_id) OR public.can_access_campaign(auth.uid(), campaign_id));

CREATE TRIGGER trg_prr_updated_at BEFORE UPDATE ON public.placement_revenue_reconciled
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
