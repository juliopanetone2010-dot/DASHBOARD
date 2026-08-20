ALTER TABLE public.sync_state ADD COLUMN IF NOT EXISTS failed_accounts text[];
ALTER TABLE public.sync_state ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
GRANT ALL ON public.sync_state TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.sync_state TO authenticated;