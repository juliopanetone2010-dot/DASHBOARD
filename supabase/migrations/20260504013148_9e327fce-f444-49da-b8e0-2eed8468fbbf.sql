drop index if exists public.campaign_automation_user_site_account_campaign_unique;

create unique index if not exists campaign_automation_user_site_account_campaign_unique
  on public.campaign_automation (user_id, site_id, google_account_id, campaign_id);