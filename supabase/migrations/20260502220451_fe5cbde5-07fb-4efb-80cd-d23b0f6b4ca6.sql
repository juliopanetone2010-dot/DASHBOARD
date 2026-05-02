CREATE UNIQUE INDEX IF NOT EXISTS placements_user_key_date_uniq
ON public.placements (user_id, placement_key, date);