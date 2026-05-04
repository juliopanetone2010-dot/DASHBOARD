ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS gam_currency text NOT NULL DEFAULT 'USD';

UPDATE public.sites
  SET gam_currency = 'BRL'
  WHERE name ILIKE 'Lucrando Home';