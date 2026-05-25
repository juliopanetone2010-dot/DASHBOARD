GRANT EXECUTE ON FUNCTION public.is_super_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_has_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_has_site_access(uuid, uuid) TO authenticated;