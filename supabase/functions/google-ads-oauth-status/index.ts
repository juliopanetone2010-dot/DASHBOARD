import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const has = (k: string) => Boolean(Deno.env.get(k));
  return new Response(JSON.stringify({
    google_client_id: has("GOOGLE_CLIENT_ID"),
    google_client_secret: has("GOOGLE_CLIENT_SECRET"),
    google_ads_developer_token: has("GOOGLE_ADS_DEVELOPER_TOKEN"),
    configured: has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET") && has("GOOGLE_ADS_DEVELOPER_TOKEN"),
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
