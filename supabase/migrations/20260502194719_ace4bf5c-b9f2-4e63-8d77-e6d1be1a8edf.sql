-- =========================================================
-- PROFILES
-- =========================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Auto-create profile + default rules on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));

  insert into public.rules_config (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- GOOGLE ADS ACCOUNTS
-- =========================================================
create table public.google_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_id text not null,
  login_customer_id text,
  account_name text,
  is_mcc boolean not null default false,
  refresh_token text,
  status text not null default 'pending',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, customer_id)
);

alter table public.google_accounts enable row level security;

create policy "Users manage own google accounts"
  on public.google_accounts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =========================================================
-- GAM ACCOUNTS
-- =========================================================
create table public.gam_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  network_code text not null,
  account_name text,
  service_account_email text,
  status text not null default 'pending',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, network_code)
);

alter table public.gam_accounts enable row level security;

create policy "Users manage own gam accounts"
  on public.gam_accounts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =========================================================
-- CAMPAIGNS
-- =========================================================
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  google_account_id uuid references public.google_accounts(id) on delete set null,
  campaign_id text not null,
  name text not null,
  status text not null default 'enabled',
  channel_type text default 'DISPLAY',
  budget_micros bigint,
  target_cpa_micros bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, campaign_id)
);

alter table public.campaigns enable row level security;

create policy "Users manage own campaigns"
  on public.campaigns for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index idx_campaigns_user on public.campaigns(user_id);

-- =========================================================
-- PLACEMENTS (receita do GAM por placement)
-- =========================================================
create table public.placements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id text,
  placement_key text not null,
  site text,
  ad_unit text,
  date date not null,
  impressions bigint not null default 0,
  revenue numeric(12,4) not null default 0,
  ecpm numeric(12,4) not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, placement_key, date)
);

alter table public.placements enable row level security;

create policy "Users manage own placements"
  on public.placements for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index idx_placements_user_date on public.placements(user_id, date);
create index idx_placements_campaign on public.placements(user_id, campaign_id);

-- =========================================================
-- DAILY METRICS (agregação cruzada Ads + GAM por dia)
-- =========================================================
create table public.daily_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id text not null,
  date date not null,
  spend numeric(12,4) not null default 0,
  clicks bigint not null default 0,
  conversions numeric(12,4) not null default 0,
  impressions bigint not null default 0,
  revenue numeric(12,4) not null default 0,
  profit numeric(12,4) not null default 0,
  roi numeric(8,4) not null default 0,
  roas numeric(8,4) not null default 0,
  ecpm numeric(12,4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, campaign_id, date)
);

alter table public.daily_metrics enable row level security;

create policy "Users manage own daily metrics"
  on public.daily_metrics for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index idx_daily_metrics_user_date on public.daily_metrics(user_id, date desc);
create index idx_daily_metrics_campaign on public.daily_metrics(user_id, campaign_id, date desc);

-- =========================================================
-- RULES CONFIG (1 por usuário — preenchido pelo trigger)
-- =========================================================
create table public.rules_config (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- limites
  min_roi_pct numeric(6,2) not null default 10,
  max_loss_roi_pct numeric(6,2) not null default -20,
  boost_roi_pct numeric(6,2) not null default 40,
  -- janelas
  analysis_days int not null default 2,
  min_spend_threshold numeric(12,2) not null default 50,
  -- modo
  auto_pause_enabled boolean not null default true,
  auto_boost_enabled boolean not null default false,
  budget_increase_pct numeric(6,2) not null default 20,
  updated_at timestamptz not null default now()
);

alter table public.rules_config enable row level security;

create policy "Users manage own rules"
  on public.rules_config for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =========================================================
-- ALERTS
-- =========================================================
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  severity text not null default 'warning',
  category text not null,
  campaign_id text,
  placement_key text,
  title text not null,
  message text,
  metric_snapshot jsonb,
  acknowledged boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.alerts enable row level security;

create policy "Users manage own alerts"
  on public.alerts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index idx_alerts_user_unack on public.alerts(user_id, acknowledged, created_at desc);

-- =========================================================
-- AUTOMATION ACTIONS (log + fila)
-- =========================================================
create table public.automation_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id text not null,
  action_type text not null,
  reason text,
  payload jsonb,
  status text not null default 'pending',
  executed_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

alter table public.automation_actions enable row level security;

create policy "Users manage own actions"
  on public.automation_actions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index idx_actions_user_status on public.automation_actions(user_id, status, created_at desc);

-- =========================================================
-- SYNC LOGS
-- =========================================================
create table public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null,
  status text not null,
  records_processed int default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.sync_logs enable row level security;

create policy "Users view own sync logs"
  on public.sync_logs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =========================================================
-- updated_at trigger genérico
-- =========================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger trg_campaigns_updated before update on public.campaigns
  for each row execute function public.set_updated_at();
create trigger trg_daily_metrics_updated before update on public.daily_metrics
  for each row execute function public.set_updated_at();
create trigger trg_rules_updated before update on public.rules_config
  for each row execute function public.set_updated_at();