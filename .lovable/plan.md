# Plan - Fix OAuth Callback Loop and 403 Errors

The user is experiencing a persistent error when connecting their Google Ads MCC account, even after several attempts to fix the OAuth flow. The screenshot shows a "non-2xx status code" from the edge function, which usually implies an unhandled error or a missing credential in the OAuth callback.

## Technical Details

1.  **Issue Identification**:
    *   The browser console error in previous turns suggested `SecurityError: Failed to set a named property 'href' on 'Location'`.
    *   The current image shows a "non-2xx status code" error.
    *   `google-ads-oauth-callback` is likely returning a 500 because `tryGetCreds` or the token exchange is failing.
    *   Credentials check shows `GOOGLE_ADS_DEVELOPER_TOKEN_2` is SET, but `GOOGLE_CLIENT_ID_2` and `GOOGLE_CLIENT_SECRET_2` are MISSING. The code uses fallbacks, but any inconsistency in environment propagation can cause issues.

2.  **Proposed Fixes**:
    *   **Frontend**: Enhance `OAuthCallback.tsx` to handle the `api_set` persistence better. If it's lost in session storage, the callback might try set 1 instead of 2.
    *   **Backend (Start)**: Ensure `google-ads-oauth-start` explicitly includes the `api_set` in the `state` parameter of the OAuth URL, so it can be reliably recovered even if `sessionStorage` fails.
    *   **Backend (Callback)**: Update `google-ads-oauth-callback` to prioritize the `api_set` found in the `state` parameter from Google, making the flow stateless and more robust.
    *   **Debug Visibility**: Add more detailed error reporting to the UI to distinguish between "Auth Denied (403)", "Invalid Credentials", and "Network Error".

## Proposed Changes

### Frontend Edits

#### `src/pages/OAuthCallback.tsx`
*   Add logic to parse the `state` parameter from the URL.
*   If `api_set` is not in `sessionStorage`, try to extract it from the `state` JSON.

#### `src/components/dashboard/IntegrationsPanel.tsx`
*   Ensure the `state` passed to the start function includes the `api_set`.

### Backend Edits (Edge Functions)

#### `supabase/functions/google-ads-oauth-start/index.ts`
*   Include `{ apiSet }` in the `state` string sent to Google.

#### `supabase/functions/google-ads-oauth-callback/index.ts`
*   Extract `api_set` from the `state` parameter if available.
*   Improve logging to pinpoint where the 500 error is coming from.

## Verification Plan

1.  **Code Review**: Verify `normalizeApiSet` and credential resolution logic.
2.  **Manual Test**: Trigger the flow and verify the `state` parameter in the Google URL.
3.  **Simulation**: Use `curl` to simulate a callback with a mock code and verify it reaches the credential resolution step without crashing.
