# Google Ads API Integration Restoration Plan

A detailed diagnostic of the Google Ads integration identified that all Edge Functions were incorrectly using API version **v24**, which does not exist and causes 404 errors. Additionally, some Jardim Astral accounts were incorrectly disabled or assigned to the wrong API set.

## User-facing changes
- **Restoration of Google Ads Sync**: Google Ads spend and campaigns will reappear on the dashboard for both Universo dos Cartões and Jardim Astral.
- **Diagnostic Transparency**: The integrations panel will be updated with a clear status report confirming that all tokens are valid and the system is using the correct API version (v18).

## Technical details
- **API Version Correction**: Batch update all occurrences of `v24` to `v18` across 15+ edge functions using `sed`.
- **Credential Validation**: Confirmed that `GOOGLE_CLIENT_ID_1` and `GOOGLE_CLIENT_ID_2` are correctly configured and tokens for both MCCs (434-538-1395 and 719-750-3782) are valid.
- **Account Reactivation**: Re-enable Jardim Astral accounts that were incorrectly disabled (`sync_enabled=false`) or misclassified in `api_set 1`.
- **Sync Trigger**: Manually trigger a synchronization for the affected accounts for 21/08/2026.

## Verification
- **Log Audit**: Check Edge Function logs for successful `200 OK` responses from the Google Ads API.
- **Database Check**: Verify that `daily_metrics` and `campaigns` tables are populated for 21/08/2026.
- **UI Audit**: Confirm that the "Gasto Google Ads" metric no longer shows R$ 0,00 for Jardim Astral.
