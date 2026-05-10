UPDATE public.campaign_automation ca
SET last_action = CASE crf.stage
    WHEN 'restart_phase1_testing' THEN 'restart_phase1_testing'
    WHEN 'restart_phase2_micro_scale' THEN 'restart_phase2_scale'
    WHEN 'restart_phase3_scale' THEN 'restart_phase3_scale'
    WHEN 'restart_phase4_full' THEN 'restart_phase4_full'
    ELSE ca.last_action
  END,
  updated_at = now()
FROM public.campaign_restart_flow crf
WHERE crf.campaign_id = ca.campaign_id
  AND ca.last_action = 'removed_for_restart'
  AND crf.status = 'active';

-- Também patch no automation-run para manter sincronizado: já feito via stageToLifecycle, mas adicionar mirror de last_action
-- (apenas dado, sem alterar schema)