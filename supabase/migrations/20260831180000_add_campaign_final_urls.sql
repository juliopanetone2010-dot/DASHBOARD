-- campaign_final_urls
-- Written by google-ads-sync-campaigns (upsert on
--   user_id,google_account_id,campaign_id,ad_id) and read by gam-sync-revenue
--   (buildFinalUrlMap) for URL-based revenue attribution.
-- The table was created directly in the old Lovable-managed database and never
-- captured as a migration, so a fresh project was missing it.

CREATE TABLE IF NOT EXISTS public.campaign_final_urls (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  google_account_id uuid NOT NULL,
  campaign_id text NOT NULL,
  ad_group_id text,
  ad_id text NOT NULL DEFAULT '',
  final_url text,
  source text,
  ad_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_final_urls_uq
    UNIQUE (user_id, google_account_id, campaign_id, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_final_urls_user_account
  ON public.campaign_final_urls (user_id, google_account_id);
CREATE INDEX IF NOT EXISTS idx_campaign_final_urls_campaign
  ON public.campaign_final_urls (user_id, campaign_id);

ALTER TABLE public.campaign_final_urls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own campaign final urls" ON public.campaign_final_urls;
CREATE POLICY "Users manage own campaign final urls"
  ON public.campaign_final_urls
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT ALL ON public.campaign_final_urls TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_final_urls TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at' AND pronamespace = 'public'::regnamespace
  ) THEN
    DROP TRIGGER IF EXISTS trg_campaign_final_urls_updated_at ON public.campaign_final_urls;
    CREATE TRIGGER trg_campaign_final_urls_updated_at
      BEFORE UPDATE ON public.campaign_final_urls
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;
