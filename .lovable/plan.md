---
title: Sync Robustness and Google Ads Quota Handling
---

The goal is to fix spend discrepancies for "Universo dos Cartões" by implementing robust quota handling, retry logic, and ensuring partial syncs are not marked as complete.

## 1. Database Schema Updates
- Update `sync_state` to track granular success/failure at the account level.
- Add fields to `sites` or `sync_state` to store which accounts need a retry.

## 2. Google Ads Sync Refactoring (`google-ads-sync-campaigns`)
- **Retry with Backoff**: Wrap API calls in a helper that detects `RESOURCE_EXHAUSTED` (429) and performs exponential backoff.
- **Batching**: Ensure campaign queries are batched per customer, avoiding N+1 calls.
- **Completion Logic**: Only update `sites.last_full_sync_at` if ALL accounts for that site were successfully fetched.
- **Error Persistence**: Store specific errors per account in `sync_state` so the UI/Cron knows what to retry.

## 3. GAM Sync Refactoring (`gam-sync-revenue`)
- **State Integrity**: Implement logic to skip overwriting revenue if a report fails/returns empty due to API errors, unless we have a high-confidence success response.

## 4. Validation & Troubleshooting
- Create a specific test script to compare Google Ads API raw spend vs DB spend for "Universo dos Cartões".
- Run manual sync after implementation and log campaign-by-campaign spend to identify the ~R$ 200 gap.

## Technical Details
- Using `Deno` in Edge Functions.
- Google Ads API v24 (search/mutate).
- Supabase `sync_state` table for tracking.
