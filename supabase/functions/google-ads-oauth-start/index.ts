import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  const url = new URL(req.url);
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? crypto.randomUUID();

  const configured = Boolean(clientId && clientSecret && devToken);

  if (!configured || !redirectUri) {
    return new Response(
      JSON.stringify({
        configured,
        error: !configured
          ? "Faltam secrets: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_ADS_DEVELOPER_TOKEN"
          : "redirect_uri obrigatório",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const params = new URLSearchParams({
    client_id: clientId!,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: "https://www.googleapis.com/auth/adwords",
    state,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return new Response(JSON.stringify({ configured: true, auth_url: authUrl, state }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
