
CREATE TABLE public.migration_pending_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  migration_id uuid NOT NULL REFERENCES public.campaign_migrations(id) ON DELETE CASCADE,
  destination_google_account_id uuid,
  destination_customer_id text NOT NULL,
  destination_campaign_id text NOT NULL,
  destination_ad_group_resource text NOT NULL,
  destination_ad_group_name text,
  source_ad_id text,
  source_ad_name text,
  source_ad_type text NOT NULL,
  display_upload_product_type text,
  source_bundle_asset text,
  final_url text NOT NULL,
  final_url_suffix text,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  zip_storage_path text,
  uploaded_ad_resource text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.migration_pending_ads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own pending ads"
  ON public.migration_pending_ads
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_pending_ads_migration ON public.migration_pending_ads(migration_id);
CREATE INDEX idx_pending_ads_user_status ON public.migration_pending_ads(user_id, status);

CREATE TRIGGER trg_pending_ads_updated
BEFORE UPDATE ON public.migration_pending_ads
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO storage.buckets (id, name, public)
VALUES ('html5-bundles', 'html5-bundles', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users read own html5 bundles"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'html5-bundles' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users upload own html5 bundles"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'html5-bundles' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users delete own html5 bundles"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'html5-bundles' AND auth.uid()::text = (storage.foldername(name))[1]);
