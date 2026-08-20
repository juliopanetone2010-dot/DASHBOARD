# Plan: Fix Site Revenue and Spend Discrepancy (Jardi Mastral)

The user is reporting that campaign spend ("gastos") for the site "Jardi Mastral" is incorrect. Previous context shows a discrepancy where site-level revenue exists but campaign-level revenue/spend is showing zero or -100% ROI.

## Proposed Changes

### 1. Investigation Phase
- Audit `account_site_links` for "Jardi Mastral" (Site ID: `4737bd19-5996-48a8-a7bb-406cfdbaa741`) to identify linked Google Ads accounts.
- Compare `daily_metrics` (Google Ads spend) against `gam_campaign_source_revenue` (GAM revenue by campaign) for today and yesterday.
- Check `google_accounts` status (active/archived) and `api_set` mapping for these accounts.

### 2. Synchronization Fixes
- Trigger a manual synchronization for the affected accounts using the appropriate API set.
- Ensure `gam-sync-revenue` and `google-ads-sync-campaigns` functions are correctly attributing data to the site ID.
- Verify if the `utm_source=google` filter in `gam_campaign_source_revenue` is capturing the correct campaign IDs from Google Ads.

### 3. UI/Engine Adjustments
- If the discrepancy is caused by incomplete attribution, adjust `src/engine/rules.ts` to handle partial data more gracefully (already started in previous turns).
- Revert the temporary text badge in `src/pages/Index.tsx` once the data is confirmed to be accurate.

## Technical Details
- **Tables involved:** `sites`, `account_site_links`, `google_accounts`, `daily_metrics`, `gam_campaign_source_revenue`, `site_metrics_daily`.
- **Functions:** `google-ads-sync-campaigns`, `gam-sync-revenue`.
- **Logic:** The system relies on `utm_campaign` matching the Google Ads `campaign_id`. If these don't match or the mapping is missing in `account_site_links`, the attribution fails.
