import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { devTokenFor, listApiSets, normalizeApiSet, tryGetCreds } from "../_shared/google_api_set.ts";

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? crypto.randomUUID();
  const apiSet = normalizeApiSet(url.searchParams.get("api_set") ?? 1);

  const creds = tryGetCreds(apiSet);
  const devToken = creds?.devToken || devTokenFor(apiSet);

  if (!devToken || !redirectUri) {
    return new Response(
      JSON.stringify({
        configured: !!devToken,
        api_set: apiSet,
        api_sets: listApiSets(),
        error: !devToken
          ? `Falta Developer Token do conjunto ${apiSet}: GOOGLE_ADS_DEVELOPER_TOKEN_${apiSet}`
          : "redirect_uri obrigatório",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Se temos devToken mas tryGetCreds falhou, é porque faltam ID/Secret (que são shareable)
  if (!creds) {
    return new Response(
      JSON.stringify({
        configured: false,
        api_set: apiSet,
        api_sets: listApiSets(),
        error: `Faltam credenciais OAuth (Client ID/Secret) para o conjunto ${apiSet}.`,
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: "https://www.googleapis.com/auth/adwords",
    state,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return new Response(JSON.stringify({ configured: true, api_set: apiSet, auth_url: authUrl, state }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
