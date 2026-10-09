-- 09/10/2026: conta da BM Zorvia (CONTA 1, USD) → site Ligado 360. O token META_ADS_TOKEN é do usuário do sistema
-- claude-api da BM Zorvia, que não enxerga a C1 (BM de terceiro): a C1 fica inativa para o sync não dar erro.
INSERT INTO public.fb_ad_accounts (user_id, ad_account_id, name, currency, site_id)
SELECT s.user_id, '1808547870452796', 'CONTA 1 (Zorvia)', 'USD', s.id
FROM public.sites s WHERE s.id = '13e49615-21e1-4351-8a7f-545348def355'
ON CONFLICT (user_id, ad_account_id) DO UPDATE SET site_id = EXCLUDED.site_id, active = true, name = EXCLUDED.name;

UPDATE public.fb_ad_accounts SET active = false WHERE ad_account_id = '1464604042241669';
