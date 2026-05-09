-- Reconciliação: campanhas marcadas como 'paused' no funil em modo dry_run, mas que estão 'enabled' no Google Ads.
-- Reverte o funnel_status para 'learning' (será reavaliado na próxima execução) e limpa paused_at.
UPDATE public.campaign_funnel cf
SET funnel_status = 'learning',
    paused_at = NULL,
    next_action_hint = 'Reconciliado: campanha estava ativa no Google Ads (pausa anterior foi dry_run)',
    updated_at = now()
FROM public.campaigns c
WHERE cf.campaign_id = c.campaign_id
  AND cf.funnel_status IN ('paused','failed-learning')
  AND c.status = 'enabled';