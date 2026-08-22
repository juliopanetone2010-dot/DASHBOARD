# Plan - Fix Campaign-Level Revenue Attribution

The user reports that while general revenue is appearing in the dashboard header, individual campaign revenue remains at zero (yielding -100% ROI). This indicates that the revenue captured from GAM is not being correctly mapped to the `campaign_id` that Google Ads uses in the `daily_metrics` table.

## User Review Required

> [!IMPORTANT]
> I have identified that the system is capturing general revenue but failing to attribute it to specific campaigns. This usually happens because the UTM parameters (like `utm_campaign`) used in your Google Ads tracking don't exactly match what GAM reports in its key-value dimensions.

## Proposed Changes

### Backend (Edge Functions)

#### `supabase/functions/gam-sync-revenue/index.ts`
- **Metric Aggregation Logic**: I will adjust the grouping logic in `syncRevenueForSite`. Specifically, I'll ensure that when querying GAM reports using `AD_EXCHANGE_CHANNEL_NAME` or custom criteria, the parser correctly handles cases where the campaign ID is returned as a raw number or a prefixed string.
- **Attribution Fallback**: I will implement a more aggressive attribution fallback. If a campaign has spend in `daily_metrics` but no revenue in `gam_campaign_source_revenue`, the system will attempt to match it using other available identifiers from the GAM report (like `URL_NAME` or `AD_UNIT`).
- **Data Integrity**: I will ensure that the `upsert` into `gam_campaign_source_revenue` correctly handles the `site_id` and `user_id` context to prevent cross-contamination that might be blocking the display.
- **Intraday Handling**: I will refine how "intraday" vs "consolidated" data is handled to ensure that new revenue snapshots aren't ignored if a previous (but incomplete) snapshot already exists for the same date.

### Frontend (Diagnostics)

#### `src/components/dashboard/IntegrationsPanel.tsx`
- Update the diagnostic display to show real-time feedback on campaign-level matching success rates.

## Technical Details

- The `daily_metrics` table is the source of truth for the dashboard campaigns table.
- Revenue is joined from `gam_campaign_source_revenue` (and fallback `gam_placement_revenue`).
- I will verify the SQL types: if `daily_metrics.campaign_id` is a string but GAM returns a number (or vice-versa), the join fails silently.
- I will add a "Deep Attribution Trace" for the campaigns shown in the user's screenshot (`23309079322`, `23021142139`, etc.) to verify exactly where the revenue drop-off occurs.
