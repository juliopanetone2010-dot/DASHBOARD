// Secrets are managed in the Supabase dashboard (Project Settings > Edge
// Functions > Secrets) or via `supabase secrets set`. Edge functions cannot
// write their own env, so this endpoint is read-only: it reports which
// Google Ads credential sets are configured. The old Lovable-agent write path
// ("set" action) is gone.
import { corsHeaders } from "../_shared/cors.ts";
import { listApiSets } from "../_shared/google_api_set.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let action = "status";
  try {
    const body = await req.json();
    if (body && typeof body.action === "string") action = body.action;
  } catch (_) {
    // no body -> default to status
  }

  if (action === "set") {
    return new Response(
      JSON.stringify({
        error:
          "Definir secrets pelo app foi desativado. Configure em: Supabase Dashboard > " +
          "Project Settings > Edge Functions > Secrets (ou `supabase secrets set`).",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sets = listApiSets();
  return new Response(
    JSON.stringify({
      ok: true,
      api_sets: sets,
      configured_api_sets: sets.filter((s) => s.configured).map((s) => s.api_set),
      gam_service_account: !!Deno.env.get("GAM_SERVICE_ACCOUNT_JSON"),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
