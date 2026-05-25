UPDATE public.campaign_final_urls SET ad_id = '' WHERE ad_id IS NULL;
ALTER TABLE public.campaign_final_urls ALTER COLUMN ad_id SET DEFAULT '';
ALTER TABLE public.campaign_final_urls ALTER COLUMN ad_id SET NOT NULL;
DROP INDEX IF EXISTS public.campaign_final_urls_uniq;
ALTER TABLE public.campaign_final_urls
  ADD CONSTRAINT campaign_final_urls_uniq UNIQUE (user_id, google_account_id, campaign_id, ad_id);