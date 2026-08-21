
-- Reset sync locks and errors for Universo and Jardim Astral
UPDATE public.sites 
SET 
  sync_lock = false, 
  sync_status = 'idle', 
  sync_error = NULL, 
  next_sync_allowed_at = NULL 
WHERE name ILIKE '%Universo%' OR name ILIKE '%Jardim%';

-- Verify the update
SELECT name, sync_status, sync_lock, next_sync_allowed_at 
FROM public.sites 
WHERE name ILIKE '%Universo%' OR name ILIKE '%Jardim%';
