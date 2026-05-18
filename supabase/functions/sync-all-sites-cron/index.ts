// sync-all-sites-cron
//
// Background auto-refresh: walks every active site, triggers a full
// site-auto-onboard refresh for each, and respects a per-site minimum
// interval so we don't hammer Google Ads / GAM APIs.
//
// Why this exists: Julio (the operator) was clicking "Atualizar" by hand to
// pull fresh Google Ads + GAM data every time he opened the dashboard. That
// button calls site-auto-onboard which fans out to ~5 child syncs and takes
// 5-30s per site — slow, manual, easy to forget. This cron runs the same
// thing on a 20-minute schedule, so the dashboard always loads against
// already-fresh data. The "Atualizar" button still works for forced full
// refresh on demand.
//
// Smart skip: if a site was synced less than MIN_INTERVAL_MIN ago we don't
// re-trigger it. Two reasons —
//   1) GAM/Google Ads quotas are real; we don't want to burn budget refreshing
//      data that already came in 5 minutes earlier.
//   2) site-auto-onboard runs in fire-and-forget background mode and updates
//      sites.last_full_sync_at when it completes. If we re-fire while a
//      previous run is still in-flight (status=processing), we double up on
//      work for no gain. The interval skips both cases.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Minimum minutes between auto-refresh runs for a single site. 15 is the
// sweet spot:
//   - shorter than the typical GAM consolidation cadence (1-6h), so we don't
//     waste calls pulling unchanged numbers;
//   - long enough that an in-progress site-auto-onboard (typically 30-60s)
//     finishes before the next tick;
//   - tunable via request body in case Julio asks for a different cadence.
const DEFAULT_MIN_INTERVAL_MIN = 15;

// Inter-site delay. site-auto-onboard runs asynchronously but firing N
// invocations in tight sequence creates a brief spike on the Supabase edge
// runtime and on Google's per-account rate limits. 2s between sites keeps
// the wave smooth without elongating the total run noticeably for <30 sites.
const INTER_SITE_DELAY_MS = 2_000;

interface SiteRow {
  id: string;
  user_id: string;
  name: string;
  status: string;
  last_full_sync_at: string | null;
  sync_status: string | null;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function triggerSiteSync(siteId: string, userId: string): Promise<{ ok: boolean; status: number; error?: string }> {
  // site-auto-onboard returns 202 immediately and does the heavy lifting in
  // the background, so this call is fast. We DO wait for the response so we
  // catch obvious mis-routing or auth errors.
  const url = `${SUPABASE_URL}/functions/v1/site-auto-onboard`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE}`,
        apikey: SERVICE_ROLE,
        // site-auto-onboard reads x-system-user-id to bypass the JWT user
        // context when called from a server-side actor (this cron is one).
        // Without it, the function falls back to anon and fails RLS.
        "x-system-user-id": userId,
      },
      body: JSON.stringify({ site_id: siteId, force: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 300) };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e instanceof Error ? e.message : e) };
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startedAt = new Date().toISOString();
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const minIntervalMin = Math.max(
      1,
      Math.min(120, Number(body?.min_interval_min ?? DEFAULT_MIN_INTERVAL_MIN)),
    );
    // Operator can force-refresh everything by passing { force: true } — same
    // signal as the on-demand button. Skips the per-site interval check.
    const forceAll = body?.force === true;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Only sites the operator hasn't paused or deleted. status='active' is
    // the common case; we include 'completed' too because legacy rows used
    // the latter as "ready" before the schema was unified.
    const { data: sites, error: sitesErr } = await admin
      .from("sites")
      .select("id, user_id, name, status, last_full_sync_at, sync_status")
      .in("status", ["active", "completed"])
      .order("last_full_sync_at", { ascending: true, nullsFirst: true });

    if (sitesErr) {
      console.error("[sync-all-sites-cron] failed to load sites", sitesErr);
      return json({ error: sitesErr.message }, 500);
    }

    const cutoff = Date.now() - minIntervalMin * 60_000;
    const triggered: Array<{ site_id: string; name: string; status: number }> = [];
    const skippedRecent: Array<{ site_id: string; name: string; minutes_since: number }> = [];
    const skippedInFlight: Array<{ site_id: string; name: string }> = [];
    const failed: Array<{ site_id: string; name: string; error: string; status: number }> = [];

    for (const site of (sites ?? []) as SiteRow[]) {
      // Skip sites where a sync is already in flight. site-auto-onboard sets
      // sync_status='processing' before starting and clears it at the end;
      // re-firing on top creates duplicate work and can race the update.
      if (!forceAll && site.sync_status === "processing") {
        skippedInFlight.push({ site_id: site.id, name: site.name });
        continue;
      }

      // Skip if synced within the rate-limit window.
      if (!forceAll && site.last_full_sync_at) {
        const lastMs = new Date(site.last_full_sync_at).getTime();
        if (Number.isFinite(lastMs) && lastMs > cutoff) {
          skippedRecent.push({
            site_id: site.id,
            name: site.name,
            minutes_since: Math.round((Date.now() - lastMs) / 60_000),
          });
          continue;
        }
      }

      const result = await triggerSiteSync(site.id, site.user_id);
      if (result.ok) {
        triggered.push({ site_id: site.id, name: site.name, status: result.status });
      } else {
        failed.push({
          site_id: site.id,
          name: site.name,
          error: result.error ?? "unknown",
          status: result.status,
        });
      }

      // Smooth the burst.
      await delay(INTER_SITE_DELAY_MS);
    }

    const summary = {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      min_interval_min: minIntervalMin,
      force_all: forceAll,
      total_sites: sites?.length ?? 0,
      triggered_count: triggered.length,
      skipped_recent_count: skippedRecent.length,
      skipped_in_flight_count: skippedInFlight.length,
      failed_count: failed.length,
      triggered,
      skipped_recent: skippedRecent,
      skipped_in_flight: skippedInFlight,
      failed,
    };

    console.log("[sync-all-sites-cron] summary", summary);
    return json({ ok: true, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sync-all-sites-cron] uncaught", msg);
    return json({ error: msg, started_at: startedAt }, 500);
  }
});
