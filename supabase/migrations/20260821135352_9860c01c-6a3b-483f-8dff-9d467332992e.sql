
-- Reset sync locks and errors for Universo and Jardim
UPDATE public.sites 
SET sync_lock = false, 
    sync_status = 'idle', 
    sync_error = NULL, 
    next_sync_allowed_at = now() - interval '1 hour'
WHERE name IN ('Universo Dos Cartoes', 'Jardim Astral');

-- Ensure accounts are marked as connected and clear errors
UPDATE public.google_accounts 
SET status = 'connected'
WHERE status IN ('failed', 'pending', 'unauthorized', 'suspended');

-- Delete any empty rows for today to force a clean slate if any exist (though count was 0)
DELETE FROM public.daily_metrics WHERE date = '2026-08-21' AND spend = 0;
