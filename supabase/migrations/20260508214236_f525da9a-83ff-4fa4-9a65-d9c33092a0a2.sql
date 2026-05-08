
CREATE TABLE public.html5_bundle_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source_google_account_id uuid,
  source_campaign_id text,
  source_campaign_name text,
  source_ad_id text,
  source_ad_name text,
  zip_storage_path text NOT NULL,
  zip_filename text,
  file_size bigint,
  content_type text DEFAULT 'application/zip',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.html5_bundle_library ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own html5 library"
ON public.html5_bundle_library FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_html5_lib_user_ad ON public.html5_bundle_library(user_id, source_ad_id);
CREATE INDEX idx_html5_lib_user_name ON public.html5_bundle_library(user_id, source_ad_name);
CREATE INDEX idx_html5_lib_user_campaign ON public.html5_bundle_library(user_id, source_campaign_id);

CREATE TRIGGER set_html5_lib_updated_at
BEFORE UPDATE ON public.html5_bundle_library
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
