
UPDATE public.sites 
SET 
  sync_lock = false, 
  sync_status = 'idle', 
  sync_error = NULL, 
  next_sync_allowed_at = NULL 
WHERE name ILIKE '%Universo%' OR name ILIKE '%Jardim%';

UPDATE public.google_accounts
SET status = 'connected'
WHERE descriptive_name ILIKE '%Universo%' OR descriptive_name ILIKE '%Jardim%';
