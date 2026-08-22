import { corsHeaders } from "../_shared/cors.ts";
import { devTokenFor, listApiSets, normalizeApiSet, tryGetCreds } from "../_shared/google_api_set.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: any = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch (e) {
      console.error("Error parsing body:", e);
    }
  }

  const url = new URL(req.url);
  const redirectUri = body.redirect_uri || req.headers.get("x-redirect-uri") || url.searchParams.get("redirect_uri") || "";
  const apiSet = normalizeApiSet(body.api_set || req.headers.get("x-api-set") || url.searchParams.get("api_set") || 1);
  const state = body.state || url.searchParams.get("state") || JSON.stringify({ id: crypto.randomUUID(), api_set: apiSet });

  const devToken = devTokenFor(apiSet);
  const creds = tryGetCreds(apiSet);

  console.log(`[oauth-start] apiSet=${apiSet} hasDevToken=${!!devToken} hasCreds=${!!creds}`);

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
