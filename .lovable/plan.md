# Plan - Fix Jardim Astral Revenue Attribution

Investigated "Jardim Astral" sync and identified that while GAM revenue is being captured in `gam_campaign_source_revenue`, it is not being attributed to `daily_metrics` because of a link ownership discrepancy in `account_site_links`. The site is owned by one user, but the mapping link was created under another user ID, causing the aggregation query in the backend function to return zero results.

## Proposed Changes

### Database Corrections
- Correct the `user_id` in `account_site_links` for the Jardim Astral site to match the actual site owner.
- Remove any orphan or duplicate links for this site.

### Backend Function (`gam-sync-revenue`)
- Remove the strict `user_id` filter when querying `account_site_links` within the revenue sync function. Since the function already filters by `site_id` (which belongs to the user) and is running with service role privileges, the extra user filter on the link table is redundant and fragile if links are shared or misattributed.
- Ensure the final aggregation step correctly updates `daily_metrics` for all linked accounts regardless of which user ID is stamped on the link record.

### Frontend (`useDashboardData`)
- Add a safety check to ensure that the site isolation logic remains robust even if multiple links exist.

## Technical Details

### SQL
```sql
-- Fix the specific misattributed link
UPDATE public.account_site_links
SET user_id = '1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9'
WHERE site_id = '4737bd19-5996-48a8-a7bb-406cfdbaa741'
AND user_id = '70755913-c3fa-4007-a36c-941c50e932b5';
```

### Edge Function: `gam-sync-revenue`
Modify `applyGoogleUtmRevenue` in `supabase/functions/gam-sync-revenue/index.ts`:
- Change line 1658: `.eq("user_id", userId)` -> remove or ensure it doesn't block valid site links.
- Verified that `userId` in this context is the owner of the site being synced.
