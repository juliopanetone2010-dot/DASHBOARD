-- Revshare por site (ex.: a maioria é 6,5%, mas alguns sites têm acordo diferente
-- com a rede). NULL = usa o padrão global (rules_config.revenue_share_pct, ou 6.5
-- se nem isso existir). Ver src/lib/revshare.ts e src/engine/rules.ts.
ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS revenue_share_pct numeric;
