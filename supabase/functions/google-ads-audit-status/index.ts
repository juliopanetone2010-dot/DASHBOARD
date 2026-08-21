import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getCreds } from "../_shared/google_api_set.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Buscar todos os MCCs conectados com refresh token
    const { data: managers, error: mErr } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, api_set")
      .eq("is_mcc", true)
      .not("refresh_token", "is", null);

    if (mErr) throw mErr;
    if (!managers || managers.length === 0) return json({ message: "Nenhum MCC encontrado" });

    const auditResults = [];

    for (const mgr of managers) {
      const creds = getCreds(mgr.api_set ?? 1);
      
      // Obter access token
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          refresh_token: mgr.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok) continue;

      // Listar todos os filhos (incluindo status)
      const query = `
        SELECT
          customer_client.id,
          customer_client.descriptive_name,
          customer_client.status,
          customer_client.manager
        FROM customer_client
      `;

      const searchRes = await fetch(
        `https://googleads.googleapis.com/v24/customers/${mgr.customer_id}/googleAds:search`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenJson.access_token}`,
            "developer-token": creds.devToken,
            "login-customer-id": mgr.customer_id,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        },
      );
      
      const searchJson = await searchRes.json();
      if (!searchRes.ok) continue;

      const clients = searchJson.results || [];
      for (const c of clients) {
        const cc = c.customerClient;
        const status = cc.status; // ENABLED, SUSPENDED, CANCELED, CLOSED, UNKNOWN
        const cid = String(cc.id);
        const isSuspended = ['SUSPENDED', 'CANCELED', 'CLOSED'].includes(status);

        // Atualizar no banco
        await admin
          .from("google_accounts")
          .update({ 
            status: status.toLowerCase(),
            sync_enabled: !isSuspended 
          })
          .eq("customer_id", cid);

        auditResults.push({
          api_set: mgr.api_set,
          customer_id: cid,
          name: cc.descriptiveName,
          status: status,
          sync_enabled: !isSuspended
        });
      }
    }

    return json({ audit: auditResults });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
