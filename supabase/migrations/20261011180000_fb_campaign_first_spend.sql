-- 11/10/2026: hora do primeiro gasto de cada campanha do Facebook (UTC), gravada pelo meta-ads-sync a partir do insights
-- por hora. A aba Facebook mostra "Gastando há" (o Julio decide pausar ~8 h depois de começar a gastar).
create table if not exists public.fb_campaign_first_spend (
  campaign_id text primary key,
  user_id uuid not null,
  first_spend_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.fb_campaign_first_spend enable row level security;
drop policy if exists "fb_campaign_first_spend do dono" on public.fb_campaign_first_spend;
create policy "fb_campaign_first_spend do dono" on public.fb_campaign_first_spend for select using (auth.uid() = user_id);
