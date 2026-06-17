UPDATE public.campaigns c
SET
  operational_status = NULL,
  operational_status_at = NULL,
  operational_status_expires_at = NULL
FROM public.account_site_links l
JOIN public.sites s ON s.id = l.site_id
WHERE c.google_account_id = l.google_account_id
  AND s.domain = 'diariovagas.com'
  AND c.operational_status = 'pricing_change'
  AND c.operational_status_at = TIMESTAMPTZ '2026-06-17 02:44:39.864076+00';