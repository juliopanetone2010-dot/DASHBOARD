
-- Audit table for placement revenue reconciliation
CREATE TABLE public.placement_revenue_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid,
  google_account_id uuid,
  campaign_id text NOT NULL,
  campaign_name text,
  period_start date NOT NULL,
  period_end date NOT NULL,
  campaign_revenue_usd numeric NOT NULL DEFAULT 0,
  placements_revenue_usd numeric NOT NULL DEFAULT 0,
  leak_amount_usd numeric NOT NULL DEFAULT 0,
  leak_percent numeric NOT NULL DEFAULT 0,
  confidence numeric NOT NULL DEFAULT 0,
  audit_status text NOT NULL DEFAULT 'unknown', -- verified | partial | leak_detected | unreliable | unknown
  parser_success_pct numeric,
  match_success_pct numeric,
  site_match_pct numeric,
  period_match_pct numeric,
  orphan_rows integer NOT NULL DEFAULT 0,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  rebuilt boolean NOT NULL DEFAULT false,
  rebuild_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pra_user_campaign_period ON public.placement_revenue_audit (user_id, campaign_id, period_end DESC);
CREATE INDEX idx_pra_status ON public.placement_revenue_audit (audit_status, created_at DESC);

ALTER TABLE public.placement_revenue_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own audit rows" ON public.placement_revenue_audit
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin granted audit read" ON public.placement_revenue_audit
  FOR SELECT TO authenticated
  USING (can_access_site(auth.uid(), site_id) OR can_access_campaign(auth.uid(), campaign_id));

CREATE TRIGGER pra_set_updated_at
  BEFORE UPDATE ON public.placement_revenue_audit
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
