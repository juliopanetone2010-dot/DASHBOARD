---
name: Revenue Attribution Fix
description: Diagnostic and fix plan for campaign-level revenue attribution in GAM sync.
type: feature
---

# Plan - Revenue Attribution Diagnostic & Fix

The user is reporting that revenue is only showing as a "Global" total and not broken down by campaign, despite previous fixes to the parser.

## Technical Analysis

1.  **Metric Groups in `gam-sync-revenue`**:
    - The code currently uses two metric groups in `collectUtmAttribution`: `ALL_SOURCES` (no dimensions) and `CHANNEL_SOURCE` (dimensions: `DATE`, `AD_EXCHANGE_CHANNEL_NAME`).
    - The `ALL_SOURCES` group provides the site-wide totals but no campaign breakdown.
    - The `CHANNEL_SOURCE` group is intended to provide the breakdown via `AD_EXCHANGE_CHANNEL_NAME`.

2.  **Potential Issues identified in `gam-sync-revenue/index.ts`**:
    - **Dimension Mismatch**: In `collectUtmAttribution`, the code calls `runReport` with `dimensions: group.dimensions ?? ["DATE", "KEY_VALUES_NAME"]`.
    - For `CHANNEL_SOURCE`, it uses `AD_EXCHANGE_CHANNEL_NAME`. However, the REST v1 API behavior for these dimensions can be finicky.
    - **Parser Limitations**: `parseKeyValueDimension` expects `key=value` format. If `AD_EXCHANGE_CHANNEL_NAME` returns a raw numeric ID (which it often does for Ad Exchange traffic if not explicitly mapped as a key-value), the `extractCampaignId` logic at line 1034-1036 *should* handle it, but only for the `rows` variable, not necessarily for the `campaignRows` filter logic at line 1066.
    - **Filter Logic Bug**: In `campaignRows` filter (line 1066), it checks `extractCampaignId(campaignRaw)` or `extractCampaignId(rawKv)` (if no `=`). If `rawKv` contains a numeric ID but the parser didn't find `utm_campaign`, it might be getting filtered out or misattributed.
    - **JOIN logic**: The dashboard joins `daily_metrics` with `gam_campaign_source_revenue`. If the `campaign_id` in the database is stored as a string with different padding or if the `utm_source` is not exactly 'google', the JOIN fails.

## Proposed Changes

### 1. Diagnostic Logging
- Add a new "Diagnostic Trace" to `IntegrationsPanel.tsx` that shows the actual raw strings returned by the GAM API for the last sync.
- Log the exact `rawKv` values and how they are being parsed in the Edge Function logs.

### 2. Edge Function Optimizations (`supabase/functions/gam-sync-revenue/index.ts`)
- **Fix `campaignRows` filter**: Ensure it correctly identifies raw numeric IDs even if they don't have the `utm_campaign=` prefix in `AD_EXCHANGE_CHANNEL_NAME`.
- **Force `utm_source=google`**: For `CHANNEL_SOURCE` rows, explicitly set the source to `google` if it's currently coming up as `unknown` or empty, as these rows represent Ad Exchange revenue which is always associated with the Google Ads campaigns in this context.
- **Normalize Campaign IDs**: Ensure `campaign_id` is always trimmed and consistently formatted before upserting.

### 3. Database & Query Verification
- Check the `gam_campaign_source_revenue` table for the existence of rows for specific `campaign_id`s like `23207554976`.
- Verify the `daily_metrics` view or query to ensure it's not filtering out `attribution_status = 'intraday'` if the user is looking at today's data.

## Implementation Steps

1.  **Update `gam-sync-revenue/index.ts`**:
    - Refine the `AD_EXCHANGE_CHANNEL_NAME` mapping to ensure it populates `cid` correctly.
    - Ensure `utm_source` is set to 'google' for Ad Exchange channel rows.
    - Add more detailed `console.log` for audit campaigns.

2.  **Update `IntegrationsPanel.tsx`**:
    - Add the requested visual text diagnostic.
    - Add a "Test Campaign Attribution" button/section that calls a specific debug mode of the Edge Function.

3.  **Verification**:
    - Run a manual sync.
    - Check logs for "AUDIT_parser" and "AUDIT_persist".
    - Verify data appears in the dashboard table.
