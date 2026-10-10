-- 10/10/2026: página de destino de cada campanha do Facebook (link dos anúncios), gravada pelo meta-ads-sync.
-- O gam-sync-revenue usa para preencher ecpm_url_usd (eCPM da URL) das campanhas do Facebook, como já faz com as do Google
-- via campaign_final_urls.
create table if not exists public.fb_campaign_urls (
  campaign_id text primary key,
  user_id uuid not null,
  ad_account_id text not null,
  url text not null,
  updated_at timestamptz not null default now()
);
alter table public.fb_campaign_urls enable row level security;
drop policy if exists "fb_campaign_urls do dono" on public.fb_campaign_urls;
create policy "fb_campaign_urls do dono" on public.fb_campaign_urls for select using (auth.uid() = user_id);
