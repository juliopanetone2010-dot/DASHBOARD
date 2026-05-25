CREATE TABLE IF NOT EXISTS public.canonical_attribution_audit_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  site_id uuid,
  period_start date NOT NULL,
  period_end date NOT NULL,
  total_gam_revenue_usd numeric NOT NULL DEFAULT 0,
  reconciled_revenue_usd numeric NOT NULL DEFAULT 0,
  aggregate_revenue_usd numeric NOT NULL DEFAULT 0,
  leak_amount_usd numeric NOT NULL DEFAULT 0,
  leak_percent numeric NOT NULL DEFAULT 0,
  campaign_match_pct numeric NOT NULL DEFAULT 0,
  exact_utm_placement_pct numeric NOT NULL DEFAULT 0,
  revenue_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_samples jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_unreconciled_rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_caar_user_created ON public.canonical_attribution_audit_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_caar_site_period ON public.canonical_attribution_audit_reports (site_id, period_start, period_end);

ALTER TABLE public.canonical_attribution_audit_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own attribution audit reports" ON public.canonical_attribution_audit_reports
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin granted attribution audit read" ON public.canonical_attribution_audit_reports
  FOR SELECT TO authenticated
  USING (public.can_access_site(auth.uid(), site_id));