// Troca code por tokens, descobre quais customer IDs o usuário liberou
// e salva o(s) MCC(s) na tabela google_accounts (sem precisar customer_id digitado).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const GUEST_USER_ID = "00000000-0000-0000-0000-000000000000";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { code, redirect_uri, account_name } = body ?? {};
    console.log("[oauth-callback] received", { hasCode: !!code, redirect_uri });

    if (!code || !redirect_uri) {
      return json({ error: "code e redirect_uri obrigatórios" });
    }

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN");
    if (!clientId || !clientSecret || !devToken) {
      return json({ error: "Secrets OAuth/Ads não configurados" });
    }

    // 1) Troca authorization code por tokens
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
    console.log("[oauth-callback] token exchange status", tokenRes.status, "ok:", tokenRes.ok);
    if (!tokenRes.ok || !tokens.refresh_token || !tokens.access_token) {
      console.error("[oauth-callback] token exchange failed", tokens);
      return json({
        error: `OAuth falhou: ${tokens?.error ?? "?"} - ${tokens?.error_description ?? JSON.stringify(tokens)}`,
        detail: tokens,
      });
    }

    // 2) Descobre quais customer IDs o usuário liberou
    const listRes = await fetch(
      "https://googleads.googleapis.com/v21/customers:listAccessibleCustomers",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "developer-token": devToken,
        },
      },
    );
    const listJson = await listRes.json();
    console.log("[oauth-callback] listAccessibleCustomers status", listRes.status);
    if (!listRes.ok) {
      console.error("[oauth-callback] list failed", listJson);
      return json({
        error: `Falhou ao listar customers: ${listJson?.error?.message ?? JSON.stringify(listJson)}`,
        detail: listJson,
      });
    }
    const resourceNames: string[] = listJson.resourceNames ?? [];
    const customerIds = resourceNames.map((r) => r.split("/")[1]);

    // 3) Resolve user_id (logado ou guest)
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const supa = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
      );
      const { data: claims } = await supa.auth.getClaims(authHeader.replace("Bearer ", ""));
      userId = claims?.claims?.sub ?? null;
    }

    // 4) Salva cada customer como MCC candidate (com refresh_token)
    let savedCount = 0;
    if (userId && customerIds.length > 0) {
      const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      for (const cid of customerIds) {
        const { error } = await admin
          .from("google_accounts")
          .upsert(
            {
              user_id: userId,
              customer_id: cid,
              account_name: account_name ?? `MCC ${cid}`,
              is_mcc: true,
              refresh_token: tokens.refresh_token,
              status: "connected",
              last_synced_at: new Date().toISOString(),
            },
            { onConflict: "user_id,customer_id" },
          );
        if (!error) savedCount++;
      }
    }

    return json({
      ok: true,
      accessible_customers: customerIds,
      saved_count: savedCount,
      requires_login: !userId,
      message: userId
        ? `Conectado. ${savedCount} conta(s) MCC salva(s). Use 'Sincronizar contas' para puxar as contas filhas.`
        : "Token recebido, mas é preciso estar logado para salvar.",
    });
  } catch (e) {
    console.error("[oauth-callback] uncaught error", e);
    return json({ error: String(e) });
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
