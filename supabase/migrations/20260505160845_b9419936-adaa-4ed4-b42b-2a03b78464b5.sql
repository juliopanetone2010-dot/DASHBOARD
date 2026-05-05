ALTER TABLE public.site_automation_config
  ADD COLUMN IF NOT EXISTS automation_enabled_at timestamptz;

CREATE OR REPLACE FUNCTION public.set_site_automation_enabled_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.automation_enabled IS TRUE
     AND (OLD IS NULL OR OLD.automation_enabled IS DISTINCT FROM TRUE OR NEW.automation_enabled_at IS NULL) THEN
    NEW.automation_enabled_at := COALESCE(NEW.automation_enabled_at, now());
  END IF;
  IF NEW.automation_enabled IS NOT TRUE THEN
    NEW.automation_enabled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_site_automation_enabled_at ON public.site_automation_config;
CREATE TRIGGER trg_set_site_automation_enabled_at
BEFORE INSERT OR UPDATE ON public.site_automation_config
FOR EACH ROW EXECUTE FUNCTION public.set_site_automation_enabled_at();

UPDATE public.site_automation_config
SET automation_enabled_at = COALESCE(automation_enabled_at, updated_at)
WHERE automation_enabled = true AND automation_enabled_at IS NULL;