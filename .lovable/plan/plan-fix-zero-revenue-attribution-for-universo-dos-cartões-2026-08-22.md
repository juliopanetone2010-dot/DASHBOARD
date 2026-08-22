# Plan: Fix Zero Revenue Attribution for "Universo dos Cartões"

The user is reporting that campaigns are still showing R$ 0.00 revenue despite spend. Previous attempts established that the GAM API is not returning UTM parameters for "Universo dos Cartões" (Network 22953977775), and a slug-based fallback was implemented. We need to verify why this fallback isn't working or if the API is returning even less data than expected.

## Technical Analysis
1.  **Network Code Mismatch:** The code shows a fallback mapping to 11-digit IDs, but the user previously mentioned 8-digit internal IDs appearing in logs.
2.  **API Dimension Limitations:** The current `runUnifiedReport` uses `DATE` and `URL` dimensions. If the URL returned by GAM is just the homepage or a generic path without the slug, the fallback fails.
3.  **Audit Logs:** The `IntegrationsPanel` text needs to be updated as requested, but the priority is making the revenue appear.

## Proposed Changes

### Backend (Edge Function)
-   **Modify `supabase/functions/gam-sync-revenue/index.ts`**:
    -   Enhance `extractCampaignId` to handle more URL variations and potentially broader slug matching.
    -   Add `AD_EXCHANGE_URL_CHANNEL_NAME` as a dimension if the REST API supports it in a stable way, or improve the `URL` parsing.
    -   Implement a more aggressive attribution strategy: if a campaign has spend but $0 revenue, and there is unattributed revenue (`__aggregate__`) for the same site, provide a diagnostic view or a better fallback.
    -   Specifically check if `23207554976`, `23309079322`, and `22923001384` are appearing in any form in the raw response.

### Frontend
-   **Update `src/components/dashboard/IntegrationsPanel.tsx`**:
    -   Update the banner text as requested by the user: "EU N TO PEDINDO PRA VC ALTERAR TEXTO, QUERO Q VEJA O POR QUE AS CAMPANHAS ESTAO SEM RECEITAS".

## Verification Plan
1.  Run the manual sync via Playwright to capture the "Execution Logs" from the `IntegrationsPanel`.
2.  Analyze the `[audit-raw]` logs in the Supabase function execution (if visible) or via the frontend debug panel.
3.  Verify if the revenue is correctly assigned to the 11-digit IDs in the database.
