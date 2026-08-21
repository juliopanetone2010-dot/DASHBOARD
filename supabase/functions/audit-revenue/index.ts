import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  const date = body.date || new Date().toISOString().slice(0, 10);
  const siteId = body.site_id;
  const userId = body.user_id || "84883d6a-4638-4229-915f-ce707018c6cc";

  console.log(`[audit-revenue] Auditing ${date} for site ${siteId}`);

  // 1. Spend check
  const { data: metrics } = await admin
    .from("daily_metrics")
    .select("campaign_id, spend, revenue")
    .eq("user_id", userId)
    .eq("date", date);
  
  const spendByCid = new Map();
  for (const m of metrics || []) {
    spendByCid.set(String(m.campaign_id), (spendByCid.get(String(m.campaign_id)) || 0) + Number(m.spend || 0));
  }

  // 2. GCSR check
  const { data: gcsr } = await admin
    .from("gam_campaign_source_revenue")
    .select("campaign_id, utm_source, revenue_usd, impressions, total_requests, match_rate_pct")
    .eq("user_id", userId)
    .eq("date", date)
    .eq("site_id", siteId);
  
  // 3. Sync State check
  const { data: syncState } = await admin
    .from("sync_state")
    .select("*")
    .eq("site_id", siteId)
    .order("last_finished_at", { ascending: false });

  return new Response(JSON.stringify({
    date,
    site_id: siteId,
    spend_campaigns: spendByCid.size,
    total_spend: [...spendByCid.values()].reduce((a, b) => a + b, 0),
    gcsr_rows: gcsr?.length || 0,
    gcsr_sample: gcsr?.slice(0, 10),
    sync_states: syncState,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
