# Plan - Fix Historical Data Visibility after MCC Sync

The user reports that old campaigns are not appearing even after connecting and syncing the MCC. This is likely because the synchronization defaults to a narrow window (e.g., LAST_7_DAYS) and might not be capturing historical data for newly connected accounts unless a broader sync is triggered.

## Technical Details

1.  **Issue Identification**:
    *   `google-ads-sync-campaigns` defaults to `segments.date DURING LAST_7_DAYS` if no date range is provided.
    *   Newly added MCC sub-accounts are "upserted" during the sync, but their historical metrics (beyond 7 days) are not automatically pulled.
    *   The `site-auto-onboard` function orchestrates the sync but might be using limited parameters.

2.  **Proposed Fixes**:
    *   **Backend (Sync)**: Update `google-ads-sync-campaigns` to handle a special `historical: true` flag that triggers a broader sync (e.g., LAST_90_DAYS or a custom range) for new accounts.
    *   **Frontend**: Add an option in the Integrations panel to "Sync Full History" (e.g., last 90 days) specifically for newly added accounts.
    *   **Automation**: When a new account is detected (first sync), automatically trigger a one-time historical sync for the last 30-60 days to ensure the dashboard isn't empty.
    *   **Visibility**: Ensure the dashboard filters (e.g., "Últimos 30 dias") actually have data to show by ensuring the sync window matches or exceeds the UI defaults.

## Proposed Changes

### Backend Edits (Edge Functions)

#### `supabase/functions/google-ads-sync-campaigns/index.ts`
*   Increase the default sync window from 7 days to 30 days to better match the dashboard's "Últimos 30 dias" default view.
*   Add support for a `window_days` parameter to allow the frontend to request deeper history.

#### `supabase/functions/site-auto-onboard/index.ts`
*   Ensure that when new accounts are discovered, it triggers a `google-ads-sync-campaigns` call with a larger window.

### Frontend Edits

#### `src/components/dashboard/IntegrationsPanel.tsx`
*   Update the "Sincronizar contas e campanhas" button to trigger a 30-day sync by default.
*   Add a "Deep Sync (90 dias)" option for users who need to recover older historical data.

## Verification Plan

1.  **Manual Test**: Check the `google-ads-sync-campaigns` logs to verify the date clause being generated.
2.  **Database Check**: Verify that `daily_metrics` table is being populated with dates further back than the last 7 days after the fix.
