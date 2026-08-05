import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { listApiSets, tryGetCreds } from "../_shared/google_api_set.ts";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sets = listApiSets();
  const set1 = sets[0];

  return new Response(JSON.stringify({
    // compat com a UI antiga (conjunto 1 = MCC original)
    google_client_id: set1.client_id,
    google_client_secret: set1.client_secret,
    google_ads_developer_token: set1.developer_token,
    configured: set1.configured,
    // novo: status de cada conjunto de credenciais
    api_sets: sets,
    configured_api_sets: sets.filter((s) => s.configured).map((s) => s.api_set),
    default_api_set: tryGetCreds(1) ? 1 : (sets.find((s) => s.configured)?.api_set ?? 1),
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
