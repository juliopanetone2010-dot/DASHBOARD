CREATE TABLE public.ai_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL,
  api_key_encrypted text,
  api_key_iv text,
  model text,
  base_url text,
  enabled boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT false,
  last_tested_at timestamptz,
  last_test_status text,
  last_test_latency_ms integer,
  last_test_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

ALTER TABLE public.ai_provider_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own ai provider configs"
  ON public.ai_provider_configs FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER ai_provider_configs_set_updated_at
  BEFORE UPDATE ON public.ai_provider_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_ai_provider_configs_user_active
  ON public.ai_provider_configs (user_id, is_active) WHERE is_active = true;