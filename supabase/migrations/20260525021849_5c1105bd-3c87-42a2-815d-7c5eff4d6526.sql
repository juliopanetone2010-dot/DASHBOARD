-- Trigger to prevent non-super-admins from changing role or is_active on their own row
CREATE OR REPLACE FUNCTION public.prevent_admin_self_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.is_super_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Only super admins can change role';
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    RAISE EXCEPTION 'Only super admins can change is_active';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'created_by is immutable for non-super-admins';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_admin_self_escalation() FROM public;

DROP TRIGGER IF EXISTS trg_prevent_admin_self_escalation ON public.admin_profiles;
CREATE TRIGGER trg_prevent_admin_self_escalation
BEFORE UPDATE ON public.admin_profiles
FOR EACH ROW
EXECUTE FUNCTION public.prevent_admin_self_escalation();