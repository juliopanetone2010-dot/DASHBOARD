# Plan: Restore and Fix GAM Revenue Attribution

We need to restore the `gam-sync-revenue` edge function to its functional state, ensuring it correctly attributes revenue to 11-digit Google Ads Campaign IDs using consolidated Google Ad Manager (GAM) data. The current implementation is hijacked with audit logic and uses a hardcoded, potentially incorrect network code.

## User Review Required

> [!IMPORTANT]
> The system identified that the network code for "Universo Dos Cartoes" in your database is `22953977775`, but the code was hardcoded to `21683973686`. I will modify the system to use the network code defined in your site settings automatically.

## Proposed Changes

### Backend (Edge Functions)

#### 1. Restore `gam-sync-revenue/index.ts`
- **Dynamic Network Code**: Remove all hardcoded references to `21683973686`. Read the `network_code` directly from the `sites` table based on the `site_id` being synced.
- **Robust Reporting Logic**: Implement the 2-step async reporting pattern (Run -> Poll -> Fetch) to handle large datasets and avoid timeouts.
- **11-Digit CID Extraction**: Refine the `utm_campaign` extraction to strictly prioritize numeric strings of 10 or more digits.
- **Attribution Fallback**:
  - Primary: `AD_EXCHANGE_URL_CHANNEL_NAME` (which often contains the numeric CID).
  - Secondary: `CUSTOM_DIMENSION` (utm_campaign) matching.
- **Zero-Value Handling**: Ensure $0 revenue records from GAM are correctly recorded for campaigns with spend, showing -100% ROI instead of "Predictive Fallback" estimates.
- **Manual Reprocessing**: The function will support a date range (`from`, `to`) to allow reprocessing historical days like 21/08 and 22/08.

#### 2. Clean up Audit Artifacts
- Remove `geo-cleanup`, `gam-kv-diagnose`, and other temporary audit functions that were used for troubleshooting.

### Database

#### 1. Site Metadata Validation
- Ensure every site in the `sites` table has the correct `network_code` associated with it.

## Technical Details

### Reporting Strategy
We will use the GAM Reporting API v1 (REST) with the following dimensions:
- `DATE`
- `AD_EXCHANGE_URL_CHANNEL_NAME`
- `CUSTOM_DIMENSION` (using `customDimensionKeyIds` mapping for `utm_campaign`)

### Attribution Formula
1. Extract `utm_campaign` from `CUSTOM_DIMENSION` or `URL_CHANNEL_NAME`.
2. Validate if the extracted value is a numeric string >= 10 digits.
3. Match against the `google_ads_campaigns` table.
4. If no match, aggregate as "Unattributed" for the site.

## Verification Plan

### Automated Tests
1. Call `gam-sync-revenue` for a specific `site_id` and date (`2026-08-22`).
2. Verify in the database (`gam_campaign_revenue` table) that records exist for 11-digit campaign IDs.
3. Check that revenue values are non-zero where expected and exactly $0.00 otherwise (no estimates).

### Manual Verification
1. Open the dashboard for "Universo Dos Cartoes".
2. Confirm the 21/08 and 22/08 ROI values are updated based on real GAM data.
