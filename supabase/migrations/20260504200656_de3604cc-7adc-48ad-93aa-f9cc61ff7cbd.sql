-- 1) exchange_rates: cache de cotações diárias
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  from_currency text NOT NULL,
  to_currency text NOT NULL,
  rate numeric NOT NULL,
  source text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_currency, to_currency)
);
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read exchange rates"
  ON public.exchange_rates FOR SELECT USING (true);

-- 2) sites: flag de override manual (para auto-detect respeitar escolha do usuário)
ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS gam_currency_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gam_currency_detected_at timestamptz;

-- 3) site_metrics_daily: viewability + eCPM por site/dia (fonte: GAM)
CREATE TABLE IF NOT EXISTS public.site_metrics_daily (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  site_id uuid NOT NULL,
  date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  measurable_impressions bigint NOT NULL DEFAULT 0,
  viewable_impressions bigint NOT NULL DEFAULT 0,
  revenue_native numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  ecpm_native numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, site_id, date)
);
ALTER TABLE public.site_metrics_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own site metrics"
  ON public.site_metrics_daily FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_site_metrics_daily_site_date
  ON public.site_metrics_daily(site_id, date DESC);
