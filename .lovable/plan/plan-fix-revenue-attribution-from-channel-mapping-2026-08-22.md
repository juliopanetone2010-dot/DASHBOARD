# Plan - Fix Revenue Attribution from Channel Mapping

The user is reporting that despite spend being pulled, revenue per Campaign ID is coming back as zero. The previous fix addressed the parser for `AD_EXCHANGE_CHANNEL_NAME` to handle raw IDs (e.g., "23207554976" instead of "utm_campaign=23207554976"), but it seems the attribution still isn't landing in the dashboard.

## User Review Required

> [!IMPORTANT]
> I have identified a potential mismatch in the database query. The dashboard (and the `daily_metrics` update) looks for revenue in `gam_campaign_source_revenue`. I need to ensure that the data parsed from the `Channel` dimension is correctly saved with the exact `campaign_id` that Google Ads uses.

## Proposed Changes

### Backend (Edge Functions)

#### `supabase/functions/gam-sync-revenue/index.ts`
- Enhance the `extractCampaignId` logic to be even more robust against different string formats in the Channel dimension.
- Add specific logging to trace why the JOIN might be failing for the reported campaigns in `daily_metrics`.
- Ensure that `utm_source` is explicitly set to 'google' when attributed via the `Channel` dimension, as `daily_metrics` might be filtering by source.
- Verify the `upsert` conflict resolution for `gam_campaign_source_revenue` to prevent duplicate or missing entries.

### Frontend (Diagnostics)

#### `src/components/dashboard/IntegrationsPanel.tsx`
- Update the diagnostic text as requested by the user.

## Technical Details

- The `Channel` dimension returns string values. If the value is just the ID (e.g., `23309079322`), the parser needs to map it to the numeric `campaign_id` used in `daily_metrics`.
- The current `upsert` uses a composite key: `user_id, site_id, campaign_id, date, utm_source`. I will verify if `site_id` is being correctly resolved for the `Channel` dimension rows.
- I will check if the `daily_metrics` table is being updated with the revenue from `gam_campaign_source_revenue` correctly by checking the aggregation loop.
