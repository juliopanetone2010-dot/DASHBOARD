ALTER TABLE public.google_accounts
  ADD COLUMN IF NOT EXISTS api_set integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_google_accounts_api_set ON public.google_accounts(api_set);