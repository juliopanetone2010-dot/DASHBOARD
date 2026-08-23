# Plan: Fix Missing Campaign Spend and -100% ROI

The user reported that campaign spend is missing, resulting in a widespread -100% ROI on the dashboard. This happens because the `gam-sync-revenue` function (restored to the August 20th logic) calculates ROI as -100% when attributed revenue is zero but spend is non-zero. The root cause appears to be that the daily campaign performance metrics (spend) from Google Ads are not correctly reaching or being reflected in the `daily_metrics` table for the current date.

## Proposed Changes

### Backend (Edge Functions)

#### 1. Audit and Fix `google-ads-sync-campaigns`
- Verify why campaign-level spend is not being inserted/updated in the `daily_metrics` table.
- Ensure the `v24` Google Ads API call is correctly fetching `metrics.cost_micros` for the requested date ranges.
- Check the upsert logic into `daily_metrics` to ensure it's not failing silently or being blocked by permission issues (though `GRANT` statements were recently applied).

#### 2. Verify `gam-sync-revenue` Attribution
- The August 20th logic relies on `AD_UNIT_NAME` and `PLACEMENT_NAME` for revenue attribution.
- Confirm that the `__aggregate__` fallback (for unattributed site-level revenue) is correctly identifying missing campaign IDs and that `daily_metrics` rows exist to receive these updates.
- Ensure the `utm_campaign` extraction from `KEY_VALUES_NAME` or `CUSTOM_CRITERIA` is successfully matching the `campaign_id` stored in the database.

#### 3. Data Repair
- Manually trigger a re-sync for the affected accounts (especially Universo Dos Cartões) for August 21st and 22nd to populate missing spend and revenue data.

### Technical Details
- **Sync Logic**: The `google-ads-sync-campaigns` function uses `segments.date` to fetch metrics. I will verify if the `dateClause` is correctly encompassing the intended period.
- **Database**: Check if `daily_metrics` has a unique constraint that might be causing conflicts during parallel syncs (spend sync vs revenue sync).
- **Permissions**: Confirm `authenticated` and `service_role` have full access to `daily_metrics` and `gam_campaign_source_revenue`.

## Verification Plan

### Automated Tests
- Run the `gam-sync-revenue/test_debug.ts` to inspect the attribution flow for specific network codes.
- Use `supabase--run_sql` to verify that `daily_metrics` now contains both `spend > 0` and `revenue >= 0` for active campaigns.

### Manual Verification
- Check the dashboard for Universo Dos Cartões to confirm ROI is no longer stuck at -100% for campaigns where revenue is being recorded.
- Verify the diagnostic panel in `IntegrationsPanel.tsx` shows successful sync counts for both Google Ads and GAM.
