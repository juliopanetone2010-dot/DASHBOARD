-- sites table (GAM properties)
CREATE TABLE public.sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  domain text NOT NULL,
  network_code text NOT NULL,
  gam_account_id uuid,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own sites" ON public.sites
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER sites_updated_at BEFORE UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- mapping Ads account <-> Site
CREATE TABLE public.account_site_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  google_account_id uuid NOT NULL,
  site_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_account_id, site_id)
);
ALTER TABLE public.account_site_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own links" ON public.account_site_links
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- enrich placements & metrics with account/site references
ALTER TABLE public.placements ADD COLUMN IF NOT EXISTS site_id uuid;
ALTER TABLE public.daily_metrics ADD COLUMN IF NOT EXISTS google_account_id uuid;

CREATE INDEX IF NOT EXISTS idx_sites_user ON public.sites(user_id);
CREATE INDEX IF NOT EXISTS idx_links_user ON public.account_site_links(user_id);
CREATE INDEX IF NOT EXISTS idx_placements_site ON public.placements(site_id);
CREATE INDEX IF NOT EXISTS idx_metrics_account ON public.daily_metrics(google_account_id);