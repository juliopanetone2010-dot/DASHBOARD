alter table public.campaign_automation
  drop constraint if exists campaign_automation_user_id_campaign_id_key;

drop index if exists public.campaign_automation_user_account_campaign_unique;

create unique index if not exists campaign_automation_user_site_account_campaign_unique
  on public.campaign_automation (user_id, site_id, google_account_id, campaign_id)
  where site_id is not null and google_account_id is not null;