ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS bidding_strategy_type text;
-- Limpa CPAs vindos de Maximize Conversions ou ad_group fallback (serão repopulados apenas para TARGET_CPA no próximo sync)
UPDATE public.campaigns SET target_cpa_micros = NULL WHERE bidding_strategy_type IS NULL OR bidding_strategy_type <> 'TARGET_CPA';