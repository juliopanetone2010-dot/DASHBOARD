
create table if not exists public.campaign_country_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  google_account_id uuid,
  campaign_id text not null,
  date date not null,
  country_code text not null,           -- ex: "BR", "HU", "ES", "ZZ" (desconhecido)
  country_name text,
  country_criterion_id text,
  cost numeric not null default 0,      -- BRL (do Ads)
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  conversions numeric not null default 0,
  revenue_usd numeric not null default 0, -- atribuído (proporcional ao custo) salvo no sync
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists campaign_country_metrics_uq
  on public.campaign_country_metrics (user_id, campaign_id, date, country_code);

create index if not exists campaign_country_metrics_user_date_idx
  on public.campaign_country_metrics (user_id, date);

alter table public.campaign_country_metrics enable row level security;

create policy "Users manage own country metrics"
  on public.campaign_country_metrics for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create trigger campaign_country_metrics_set_updated_at
  before update on public.campaign_country_metrics
  for each row execute function public.set_updated_at();
