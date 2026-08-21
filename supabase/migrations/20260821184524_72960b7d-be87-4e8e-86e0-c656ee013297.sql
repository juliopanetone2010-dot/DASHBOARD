ALTER TABLE public.gam_placement_revenue ADD COLUMN IF NOT EXISTS attribution_status text DEFAULT 'consolidated';
GRANT ALL ON public.gam_placement_revenue TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gam_placement_revenue TO authenticated;