GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_retention_revenue TO authenticated;
GRANT ALL ON public.push_retention_revenue TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.unattributed_push_revenue TO authenticated;
GRANT ALL ON public.unattributed_push_revenue TO service_role;