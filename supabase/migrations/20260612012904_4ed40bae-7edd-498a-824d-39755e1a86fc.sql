ALTER TABLE public.gam_campaign_source_revenue 
ADD COLUMN IF NOT EXISTS total_requests bigint NOT NULL DEFAULT 0;