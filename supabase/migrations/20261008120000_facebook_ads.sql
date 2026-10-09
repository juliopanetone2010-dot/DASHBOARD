-- Facebook (Meta Ads) na dash — 08/10/2026.
--
-- O gasto vem da API de Marketing da Meta (função meta-ads-sync, token META_ADS_TOKEN de um usuário do
-- sistema com ads_read). A receita já existe: o anúncio do site manda utm_campaign para o GAM e o
-- gam-sync-revenue grava em gam_campaign_source_revenue com campaign_id = ID da campanha do Facebook
-- (gravado como utm_source='google', porque o parser marca assim todo utm_campaign numérico). A aba
-- Facebook cruza as duas tabelas pelo campaign_id dentro do site da conta.
--
-- Tabelas próprias em vez de daily_metrics: daily_metrics/campaigns são da conta Google
-- (google_account_id, gasto em BRL) e a Meta gasta em USD.

CREATE TABLE IF NOT EXISTS public.fb_ad_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  ad_account_id text NOT NULL,          -- sem o "act_"
  name text,
  currency text NOT NULL DEFAULT 'USD',
  site_id uuid REFERENCES public.sites(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, ad_account_id)
);

CREATE TABLE IF NOT EXISTS public.fb_ad_daily (
  user_id uuid NOT NULL,
  ad_account_id text NOT NULL,
  date date NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  adset_id text,
  adset_name text,
  ad_id text NOT NULL,
  ad_name text,
  spend numeric NOT NULL DEFAULT 0,     -- moeda da conta (fb_ad_accounts.currency)
  impressions bigint NOT NULL DEFAULT 0,
  link_clicks bigint NOT NULL DEFAULT 0,
  landing_page_views bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ad_id, date)
);

CREATE INDEX IF NOT EXISTS fb_ad_daily_campaign ON public.fb_ad_daily (user_id, campaign_id, date);

ALTER TABLE public.fb_ad_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_ad_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own fb ad accounts" ON public.fb_ad_accounts;
CREATE POLICY "Users manage own fb ad accounts" ON public.fb_ad_accounts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users read own fb ad daily" ON public.fb_ad_daily;
CREATE POLICY "Users read own fb ad daily" ON public.fb_ad_daily
  FOR SELECT USING (auth.uid() = user_id);

-- Conta C1 (BM Elisandra) → site Lucrando (lucrandohome.com).
INSERT INTO public.fb_ad_accounts (user_id, ad_account_id, name, currency, site_id)
SELECT s.user_id, '1464604042241669', 'C1', 'USD', s.id
FROM public.sites s WHERE s.id = '9011db8e-cd6c-4b9f-931c-3a5973daf00e'
ON CONFLICT (user_id, ad_account_id) DO NOTHING;

-- Sincroniza o gasto de hora em hora (mesmo padrão de auth de 20260901120000_cron_periodic_revenue_sync.sql).
DO $$ BEGIN PERFORM cron.unschedule('meta-ads-sync-hourly'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'meta-ads-sync-hourly',
  '7 * * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://xqpbkvlaxoswgwedscqf.supabase.co/functions/v1/meta-ads-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
        current_setting('app.settings.service_role_key', true)
      )
    ),
    body := '{}'::jsonb
  );
  $CRON$
);
