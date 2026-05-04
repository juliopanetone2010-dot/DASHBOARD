UPDATE public.rules_config
SET auto_stoploss_min_roi = -20,
    updated_at = now()
WHERE auto_stoploss_min_roi >= 0;

UPDATE public.campaign_automation
SET lifecycle_status = 'learning',
    last_action = NULL,
    last_action_date = NULL,
    cooldown_until = NULL,
    updated_at = now()
WHERE lifecycle_status = 'bad'
  AND last_roi > (
    SELECT COALESCE(NULLIF(r.auto_stoploss_min_roi, 0), -20)
    FROM public.rules_config r
    WHERE r.user_id = campaign_automation.user_id
    LIMIT 1
  );