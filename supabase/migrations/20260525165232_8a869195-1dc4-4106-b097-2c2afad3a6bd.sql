-- Add aggregate allocation columns
ALTER TABLE public.placement_revenue_reconciled
  ADD COLUMN IF NOT EXISTS aggregate_allocated_revenue_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allocation_status text NOT NULL DEFAULT 'verified',
  ADD COLUMN IF NOT EXISTS allocation_method text;

ALTER TABLE public.canonical_attribution_audit_reports
  ADD COLUMN IF NOT EXISTS aggregate_allocated_revenue_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aggregate_unresolved_revenue_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aggregate_distribution jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_prr_allocation_status ON public.placement_revenue_reconciled(allocation_status);
