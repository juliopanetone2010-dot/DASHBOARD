CREATE TABLE IF NOT EXISTS public.campaign_final_urls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  google_account_id uuid,
  campaign_id text NOT NULL,
  ad_group_id text,
  ad_id text,
  final_url text,
  mobile_url text,
  tracking_template text,
  final_url_suffix text,
  source text NOT NULL DEFAULT 'ad.final_urls',
  ad_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_final_urls_uniq
  ON public.campaign_final_urls (user_id, google_account_id, campaign_id, COALESCE(ad_id, ''));

CREATE INDEX IF NOT EXISTS campaign_final_urls_campaign_idx
  ON public.campaign_final_urls (campaign_id);

ALTER TABLE public.campaign_final_urls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own final urls"
  ON public.campaign_final_urls
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "admin granted final urls read"
  ON public.campaign_final_urls
  FOR SELECT
  TO authenticated
  USING (public.can_access_account(auth.uid(), google_account_id));

CREATE TRIGGER set_campaign_final_urls_updated_at
  BEFORE UPDATE ON public.campaign_final_urls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();