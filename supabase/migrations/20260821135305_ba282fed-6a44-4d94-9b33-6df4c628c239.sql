
-- Reset sync locks and errors for Universo and Jardim
UPDATE public.sites 
SET sync_lock = false, 
    sync_status = 'idle', 
    sync_error = NULL, 
    next_sync_allowed_at = now() - interval '1 hour'
WHERE name IN ('Universo Dos Cartoes', 'Jardim Astral');

-- Ensure accounts are marked as connected
UPDATE public.google_accounts 
SET status = 'connected'
WHERE status = 'failed' OR status = 'pending';
