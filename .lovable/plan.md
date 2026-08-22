# Plan - Fix GAM Revenue Sync for Universo dos Cartões

The user is reporting that campaigns are not pulling revenue for the site "Universo dos Cartões," even though the logic was recently updated to use URL extraction. Investigation shows that for Aug 21-22, the database contains short 8-digit IDs (internal GAM IDs) and `__aggregate__` markers instead of the expected 11-digit Google Ads Campaign IDs. This confirms that the API is still not returning the 11-digit strings in the `URL` dimension for these dates, likely due to propagation latency or dimension limits.

## User Review Required
> [!IMPORTANT]
> The system is currently prepared to capture the revenue, but the **Google Ad Manager API** itself is not returning the 11-digit campaign IDs in the data stream for today/yesterday, despite them being visible in the manual UI. This is a known propagation issue when "Custom Dimension Key-Values" reach ~99% capacity (currently at 98.58%).

## Technical Changes

### Backend (Supabase Functions)
- **Enhanced Logging**: Add deep auditing to `gam-sync-revenue` to capture the *exact* raw URL strings returned by the API to see why the regex `\b(\d{10,12})\b` might be failing or what is being returned instead.
- **Attribution Logic Refinement**: 
    - If a row is `unattributed` but has revenue, attempt a second pass using a broader regex or searching for common patterns like `campaignid=...`.
    - Implement a "Revenue Recovery" step: if 11-digit IDs are missing but 8-digit internal IDs exist, try to map the internal IDs to Campaign IDs if a mapping exists in `google_ads_campaigns`.
- **SOAP Fallback**: Re-introduce a targeted SOAP call for specific missing IDs if the REST v1 Beta remains silent.

## Verification Plan
- **Manual Execution**: Run the `gam-sync-revenue` function specifically for the Universo site for `2026-08-22`.
- **Log Inspection**: Check logs for "raw=" entries to see the actual URLs Google is sending.
- **Database Check**: Verify if `gam_campaign_source_revenue` updates from `__aggregate__` to real IDs after the logic tweak.
