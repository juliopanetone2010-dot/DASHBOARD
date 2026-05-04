-- Reseta lifecycle "bad" para campanhas com ROI acima do novo limite (-20%).
-- Serão reclassificadas no próximo run.
UPDATE public.campaign_automation
SET lifecycle_status = 'learning',
    last_action = NULL,
    last_action_date = NULL,
    cooldown_until = NULL,
    updated_at = now()
WHERE lifecycle_status = 'bad'
  AND (last_roi IS NULL OR last_roi > -20);