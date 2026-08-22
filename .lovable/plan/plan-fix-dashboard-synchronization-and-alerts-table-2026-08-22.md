# Plan: Fix Dashboard Synchronization and Alerts Table

The user is reporting that campaign revenue is not showing correctly and that the "interacao" screen (Integrations Panel) is showing an error. Analysis of console logs and database queries reveals two primary issues:
1. **Database Error**: The frontend is attempting to fetch data from the `alerts` table, which results in a `500 Internal Server Error` (PostgREST error). This is often due to missing `GRANT` permissions on the table after creation, even if RLS is enabled.
2. **Revenue Sync Visibility**: While manual audits show revenue exists in the raw `gam_campaign_source_revenue` table for some campaigns, the consolidated `daily_metrics` table (which powers the main dashboard) may not be reflecting these values if the attribution logic or the aggregate sync between raw revenue and metrics is failing or delayed.

## Technical Details

### 1. Fix `alerts` table permissions
The `alerts` table exists but requests are failing with a 500 error. I will apply the required `GRANT` statements to ensure the `authenticated` and `service_role` roles can access it.

### 2. Verify and Repair Metric Consolidation
The dashboard relies on `daily_metrics`. If `gam_campaign_source_revenue` has data but `daily_metrics` does not, the process that updates metrics is likely failing. I will check the `gam-sync-revenue` edge function to ensure it properly updates the `daily_metrics` table after attributing revenue.

### 3. Clear Dashboard Error Text
The user requested to update the verbatim text on the `body` and the Integrations Panel to reflect their diagnostic request. I will ensure the UI accurately displays the requested text while I work on the fix.

## Proposed Changes

### Database (Supabase)
- Apply `GRANT ALL ON public.alerts TO authenticated, service_role;` to fix the 500 error seen in the user's screenshot.
- Verify `GRANT`s on `gam_campaign_source_revenue` and `sync_state`.

### Edge Functions
- Inspect `supabase/functions/gam-sync-revenue/index.ts` to ensure it performs the upsert into `daily_metrics` correctly for the specific Site ID and Campaign IDs mentioned.

### Frontend
- Update `src/components/dashboard/IntegrationsPanel.tsx` to include the new verbatim text requested by the user.

## Verification Plan
- **Database**: Run a query to check if `alerts` is accessible.
- **Sync**: Trigger a manual sync via the UI (simulated or via edge function call) and check if `daily_metrics` revenue column is updated for CID `23207554976`.
- **UI**: Confirm the 500 error in the console disappears and the requested text is visible.
