
REVOKE EXECUTE ON FUNCTION public.effective_role(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.accessible_sites(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_access_module(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_access_google_account(uuid, uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.effective_role(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accessible_sites(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_module(uuid, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_google_account(uuid, uuid, boolean, boolean) TO authenticated, service_role;
