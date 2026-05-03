
CREATE TABLE public.ads_placements (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  google_account_id uuid,
  campaign_id text NOT NULL,
  campaign_name text,
  ad_group_id text,
  ad_group_name text,
  placement text NOT NULL,
  display_name text,
  target_url text,
  placement_type text,
  date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost numeric NOT NULL DEFAULT 0,
  conversions numeric NOT NULL DEFAULT 0,
  ctr numeric NOT NULL DEFAULT 0,
  avg_cpc numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, google_account_id, campaign_id, ad_group_id, placement, date)
);

CREATE INDEX ads_placements_user_campaign_date_idx
  ON public.ads_placements (user_id, campaign_id, date DESC);

ALTER TABLE public.ads_placements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own ads placements"
  ON public.ads_placements FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER ads_placements_set_updated_at
  BEFORE UPDATE ON public.ads_placements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Tabela de blacklist/favoritos por placement
CREATE TABLE public.placement_actions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  campaign_id text,
  placement text NOT NULL,
  action text NOT NULL CHECK (action IN ('blacklist','favorite')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, placement, action)
);

ALTER TABLE public.placement_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own placement actions"
  ON public.placement_actions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
