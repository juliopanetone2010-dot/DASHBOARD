-- Permite vincular mais de um site à mesma conta Ads.
-- Antes: UNIQUE (google_account_id) → 1 conta = 1 site.
-- Agora: UNIQUE (google_account_id, site_id) e um site "principal" por conta.
-- Quando a conta tem mais de um site, cada campanha vai para o site cujo domínio
-- casa com a URL final da campanha; sem casamento, vai para o principal.

ALTER TABLE public.account_site_links
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.account_site_links
  DROP CONSTRAINT IF EXISTS account_site_links_account_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'account_site_links_account_site_unique'
  ) THEN
    ALTER TABLE public.account_site_links
      ADD CONSTRAINT account_site_links_account_site_unique UNIQUE (google_account_id, site_id);
  END IF;
END $$;

-- No máximo um principal por conta.
CREATE UNIQUE INDEX IF NOT EXISTS account_site_links_one_primary
  ON public.account_site_links (google_account_id)
  WHERE is_primary;
