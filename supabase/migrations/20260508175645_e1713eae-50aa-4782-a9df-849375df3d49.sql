
CREATE TABLE public.campaign_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,

  source_google_account_id uuid,
  source_site_id uuid,
  source_campaign_id text NOT NULL,
  source_campaign_name text,
  source_domain text,

  destination_site_id uuid,
  destination_google_account_id uuid,
  destination_campaign_id text,
  destination_domain text,

  final_url text NOT NULL,
  tracking_template text,
  final_url_suffix text,
  name_suffix text DEFAULT '[MIG]',
  initial_budget numeric,

  status text NOT NULL DEFAULT 'pending',
  error text,
  payload jsonb,
  result jsonb
);

ALTER TABLE public.campaign_migrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own migrations"
ON public.campaign_migrations
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_campaign_migrations_user ON public.campaign_migrations(user_id, created_at DESC);
CREATE INDEX idx_campaign_migrations_source ON public.campaign_migrations(user_id, source_campaign_id);
