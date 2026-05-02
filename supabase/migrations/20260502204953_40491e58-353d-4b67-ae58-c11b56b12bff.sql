-- 1) Novos campos em google_accounts
ALTER TABLE public.google_accounts
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS manager_account_id UUID,
  ADD COLUMN IF NOT EXISTS descriptive_name TEXT;

-- Garante unique (user_id, customer_id) para upsert por MCC sync
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'google_accounts_user_customer_unique'
  ) THEN
    ALTER TABLE public.google_accounts
      ADD CONSTRAINT google_accounts_user_customer_unique UNIQUE (user_id, customer_id);
  END IF;
END $$;

-- 2) Regra 1:1 em account_site_links: cada conta Ads só pode estar vinculada a 1 site.
-- Se já houver duplicatas, mantemos só a mais recente.
DELETE FROM public.account_site_links a
USING public.account_site_links b
WHERE a.google_account_id = b.google_account_id
  AND a.created_at < b.created_at;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'account_site_links_account_unique'
  ) THEN
    ALTER TABLE public.account_site_links
      ADD CONSTRAINT account_site_links_account_unique UNIQUE (google_account_id);
  END IF;
END $$;
