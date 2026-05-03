alter table public.placement_actions
  drop constraint if exists placement_actions_user_id_placement_action_key;

create unique index if not exists placement_actions_user_campaign_placement_action_key
on public.placement_actions (
  user_id,
  coalesce(campaign_id, ''),
  placement,
  action
);