import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getCreds } from "../_shared/google_api_set.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const apiSet = 2;
    const { clientId, clientSecret, devToken } = getCreds(apiSet);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    
    // Pegar a MCC do Jardim Astral
    const { data: mccAccount } = await admin.from("google_accounts")
      .select("*")
      .eq("customer_id", "7197503782")
      .eq("api_set", apiSet)
      .maybeSingle();

    if (!mccAccount) {
      return new Response(JSON.stringify({ error: "MCC account not found in DB for Set 2" }), { headers: corsHeaders });
    }

    // 1. Obter Access Token
    const authUrl = "https://oauth2.googleapis.com/token";
    const authRes = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: mccAccount.refresh_token!,
        grant_type: "refresh_token"
      }),
    });
    
    const authJson = await authRes.json();
    if (!authRes.ok) {
      return new Response(JSON.stringify({ step: "auth", error: authJson, api_set: apiSet }), { headers: corsHeaders });
    }
    const accessToken = authJson.access_token;

    // 2. Tentar listar sub-contas (para validar MCC)
    const listRes = await fetch(`https://googleads.googleapis.com/v19/customers/${mccAccount.customer_id}/googleAds:search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": devToken,
        "login-customer-id": mccAccount.customer_id,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: "SELECT customer_client.id, customer_client.descriptive_name FROM customer_client WHERE customer_client.status = 'ENABLED'"
      }),
    });
    
    const listJson = await listRes.json();
    if (!listRes.ok) {
      return new Response(JSON.stringify({ 
        step: "list_accounts", 
        error: listJson.error, 
        customer_id: mccAccount.customer_id, 
        login_customer_id: mccAccount.customer_id,
        api_set: apiSet 
      }), { headers: corsHeaders });
    }

    // 3. Se funcionou, pegar uma conta filha ativa para buscar gastos
    const children = listJson.results ?? [];
    const results: any[] = [];
    
    for (const child of children) {
      const childCid = child.customerClient.id;
      if (childCid === mccAccount.customer_id) continue;
      
      const query = `
        SELECT 
          campaign.id, 
          campaign.name, 
          metrics.cost_micros, 
          segments.date 
        FROM campaign 
        WHERE segments.date DURING TODAY
      `;
      
      const camRes = await fetch(`https://googleads.googleapis.com/v19/customers/${childCid}/googleAds:search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devToken,
          "login-customer-id": mccAccount.customer_id,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query }),
      });
      
      const camJson = await camRes.json();
      results.push({ 
        customer_id: childCid, 
        ok: camRes.ok, 
        data: camJson.results, 
        error: camRes.ok ? null : camJson.error 
      });
    }

    return new Response(JSON.stringify({ 
      ok: true, 
      mcc: mccAccount.customer_id, 
      auth: "success", 
      children_count: children.length,
      details: results 
    }), { headers: corsHeaders });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { headers: corsHeaders });
  }
});
