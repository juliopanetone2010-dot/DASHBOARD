WITH last_yest AS (
  SELECT DISTINCT ON (campaign_id, user_id) campaign_id, user_id, lifecycle_to
  FROM automation_logs
  WHERE created_at < '2026-05-09'::date AND lifecycle_to IS NOT NULL
  ORDER BY campaign_id, user_id, created_at DESC
)
UPDATE campaign_automation ca
SET lifecycle_status = ly.lifecycle_to,
    updated_at = now()
FROM last_yest ly
WHERE ly.campaign_id = ca.campaign_id
  AND ly.user_id = ca.user_id
  AND ca.lifecycle_status = 'testing'
  AND ly.lifecycle_to <> 'testing';