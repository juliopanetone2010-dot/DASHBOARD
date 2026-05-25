-- 1) Fix privilege escalation on admin_profiles
DROP POLICY IF EXISTS "super insert profile" ON public.admin_profiles;

CREATE POLICY "Only super admins can insert profiles"
ON public.admin_profiles
FOR INSERT
TO authenticated
WITH CHECK (public.is_super_admin(auth.uid()));

-- 2) Add UPDATE policy for html5-bundles storage bucket
DROP POLICY IF EXISTS "html5-bundles owner update" ON storage.objects;
CREATE POLICY "html5-bundles owner update"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'html5-bundles'
  AND (auth.uid())::text = (storage.foldername(name))[1]
)
WITH CHECK (
  bucket_id = 'html5-bundles'
  AND (auth.uid())::text = (storage.foldername(name))[1]
);

-- 3) Revoke direct EXECUTE on admin SECURITY DEFINER helpers from anon/authenticated.
-- They remain usable inside RLS policies (evaluated under owner context).
REVOKE EXECUTE ON FUNCTION public.is_super_admin(uuid) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.admin_has_permission(uuid, text) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.admin_has_site_access(uuid, uuid) FROM anon, authenticated, public;