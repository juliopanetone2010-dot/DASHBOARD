-- 10/10/2026: resultado da campanha (a conversão em que o conjunto otimiza, igual à coluna Resultados do Gerenciador).
alter table public.fb_ad_daily add column if not exists results numeric not null default 0;
alter table public.fb_ad_daily add column if not exists result_name text;
