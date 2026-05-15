INSERT INTO public.scale_unlock_config (user_id, enabled, dry_run)
SELECT p.id, true, false FROM public.profiles p
ON CONFLICT (user_id) DO UPDATE SET enabled = true, dry_run = false;