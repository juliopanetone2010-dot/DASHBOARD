import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { code, redirect_uri, account_name, customer_id, login_customer_id } = body ?? {};

    if (!code || !redirect_uri) {
      return new Response(JSON.stringify({ error: "code e redirect_uri obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: "Secrets OAuth não configurados" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Trade code → tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      return new Response(JSON.stringify({ error: "OAuth falhou", detail: tokens }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Save google_account if user authenticated
    const authHeader = req.headers.get("Authorization");
    let savedId: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: claims } = await supabase.auth.getClaims(authHeader.replace("Bearer ", ""));
      const userId = claims?.claims?.sub;
      if (userId && customer_id) {
        const { data, error } = await supabase
          .from("google_accounts")
          .upsert({
            user_id: userId,
            customer_id: String(customer_id),
            login_customer_id: login_customer_id ?? null,
            account_name: account_name ?? null,
            refresh_token: tokens.refresh_token,
            status: "connected",
            last_synced_at: new Date().toISOString(),
          }, { onConflict: "user_id,customer_id" } as never)
          .select("id").maybeSingle();
        if (error) console.error("save error", error);
        savedId = data?.id ?? null;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      saved_id: savedId,
      has_refresh_token: true,
      stored: Boolean(savedId),
      message: savedId
        ? "Refresh token salvo no backend"
        : "Token recebido. Faça login para persistir, ou cadastre customer_id antes.",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
