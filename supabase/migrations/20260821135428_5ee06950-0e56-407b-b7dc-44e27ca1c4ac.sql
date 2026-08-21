
-- Final force reset for today
UPDATE public.sites 
SET sync_lock = false, 
    sync_status = 'idle', 
    sync_error = NULL, 
    next_sync_allowed_at = now() - interval '2 hours'
WHERE name IN ('Universo Dos Cartoes', 'Jardim Astral');

UPDATE public.google_accounts 
SET status = 'connected',
    refresh_token = refresh_token -- dummy update to trigger any potential sync watchers
WHERE status != 'connected' OR last_synced_at < now() - interval '1 hour';

DELETE FROM public.daily_metrics WHERE date = '2026-08-21' AND spend = 0;
