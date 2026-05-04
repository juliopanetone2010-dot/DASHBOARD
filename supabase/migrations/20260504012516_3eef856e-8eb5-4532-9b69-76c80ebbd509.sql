create table if not exists public.site_automation_config (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  site_id uuid not null,
  google_account_id uuid not null,
  automation_enabled boolean not null default false,
  automation_dry_run boolean not null default true,
  last_run_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (user_id, site_id, google_account_id)
);

alter table public.site_automation_config enable row level security;

do $$ begin
  create policy "Users manage own site automation config"
  on public.site_automation_config
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

alter table public.campaign_automation
  add column if not exists site_id uuid;

alter table public.automation_logs
  add column if not exists site_id uuid,
  add column if not exists google_account_id uuid;

create index if not exists idx_site_automation_config_user_site_account
  on public.site_automation_config (user_id, site_id, google_account_id);

create index if not exists idx_campaign_automation_user_site_account_campaign
  on public.campaign_automation (user_id, site_id, google_account_id, campaign_id);

create index if not exists idx_automation_logs_user_site_account_campaign
  on public.automation_logs (user_id, site_id, google_account_id, campaign_id, created_at desc);

create unique index if not exists campaign_automation_user_account_campaign_unique
  on public.campaign_automation (user_id, google_account_id, campaign_id);

drop trigger if exists update_site_automation_config_updated_at on public.site_automation_config;
create trigger update_site_automation_config_updated_at
before update on public.site_automation_config
for each row execute function public.set_updated_at();