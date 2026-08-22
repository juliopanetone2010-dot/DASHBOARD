UPDATE sites SET sync_status = 'idle', sync_error = NULL, next_sync_allowed_at = NULL, sync_lock = false 
WHERE id IN ('4737bd19-5996-48a8-a7bb-406cfdbaa741', '28404d69-ba48-432c-ae7c-2610f79ab81f');