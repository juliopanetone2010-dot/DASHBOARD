-- Tornar stop-loss mais conservador por padrão.
-- Antes: ROI < 0% por 7d com R$400+ → pausa (pegava campanhas com -2%)
-- Agora: ROI < -20% por 7d com R$400+ → pausa (só ROI realmente ruim)

ALTER TABLE public.rules_config
  ALTER COLUMN auto_stoploss_min_roi SET DEFAULT -20;

-- Corrige usuários que estavam no default antigo (0)
UPDATE public.rules_config
SET auto_stoploss_min_roi = -20
WHERE auto_stoploss_min_roi = 0;