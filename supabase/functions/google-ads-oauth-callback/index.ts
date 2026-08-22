// Troca code por tokens, descobre quais customer IDs o usuário liberou
// e salva o(s) MCC(s) na tabela google_accounts (sem precisar customer_id digitado).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { normalizeApiSet, tryGetCreds } from "../_shared/google_api_set.ts";

const GUEST_USER_ID = "00000000-0000-0000-0000-000000000000";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { code, state, redirect_uri, account_name } = body ?? {};
    
    let apiSet = normalizeApiSet(body?.api_set ?? 1);
    
    // Tenta extrair api_set do state (JSON vindo do start)
    if (state) {
      try {
        const parsedState = JSON.parse(state);
        if (parsedState.api_set) apiSet = normalizeApiSet(parsedState.api_set);
      } catch (e) {
        console.log("[oauth-callback] state is not JSON, using default/provided apiSet");
      }
    }
    
    console.log("[oauth-callback] received", { hasCode: !!code, hasState: !!state, redirect_uri, apiSet });

    if (!code || !redirect_uri) {
      return json({ error: "code e redirect_uri obrigatórios" }, 400);
    }

    const creds = tryGetCreds(apiSet);
    if (!creds) {
      return json({ error: `Secrets do conjunto ${apiSet} não configurados` }, 400);
    }
    const { clientId, clientSecret, devToken } = creds;

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
      const errorMsg = tokens?.error_description || tokens?.error || JSON.stringify(tokens);
      return json({
        error: `Falha na troca de token (OAuth): ${errorMsg}`,
        detail: tokens,
        api_set: apiSet,
        creds_used: { clientId: creds.clientId.slice(0, 8) + "..." }
      }, 400);
    }

    // 2) Descobre quais customer IDs o usuário liberou
    const listRes = await fetch(
      "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "developer-token": devToken,
        },
      },
    );
    const listText = await listRes.text();
    let listJson: any = null;
    try { listJson = JSON.parse(listText); } catch { /* HTML response */ }
    console.log("[oauth-callback] listAccessibleCustomers status", listRes.status);
    if (!listRes.ok || !listJson) {
      console.error("[oauth-callback] list failed", listRes.status, listText.slice(0, 300));
      return json({
        error: `Falhou ao listar contas (status ${listRes.status}): ${listJson?.error?.message ?? listText.slice(0, 200)}`,
      }, 400);
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

    // 4) Para cada customer acessível: pega detalhes e, se for MCC, expande sub-contas
    const enriched: Array<{
      cid: string;
      name: string;
      currency: string | null;
      isMcc: boolean;
      loginCustomerId: string | null;
    }> = [];

    const gaqlSearch = async (loginCid: string | null, targetCid: string, query: string) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokens.access_token}`,
        "developer-token": devToken,
        "Content-Type": "application/json",
      };
      if (loginCid) headers["login-customer-id"] = loginCid;
      const r = await fetch(
        `https://googleads.googleapis.com/v25/customers/${targetCid}/googleAds:search`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ query }),
        },
      );
      const t = await r.text();
      let j: any = null;
      try { j = JSON.parse(t); } catch { j = { error: { message: t.slice(0, 200) } }; }
      if (!r.ok) {
        console.error(`[gaql] ${targetCid} (login=${loginCid}) failed`, r.status, JSON.stringify(j).slice(0, 300));
      }
      return { ok: r.ok, status: r.status, json: j };
    };

    for (const cid of customerIds) {
      // detalhe da própria conta acessível (geralmente MCC)
      const det = await gaqlSearch(
        null,
        cid,
        "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer",
      );
      const row = det.json?.results?.[0]?.customer;
      const selfName = row?.descriptiveName ?? `Conta ${cid}`;
      const selfCurrency = row?.currencyCode ?? null;
      const selfIsMcc = !!row?.manager;
      if (selfIsMcc) {
        enriched.push({
          cid,
          name: selfName,
          currency: selfCurrency,
          isMcc: true,
          loginCustomerId: null,
        });
      } else {
        enriched.push({
          cid,
          name: selfName,
          currency: selfCurrency,
          isMcc: false,
          loginCustomerId: null,
        });
      }
      console.log(`[oauth-callback] self ${cid}: name="${selfName}" mcc=${selfIsMcc} currency=${selfCurrency}`);

      // Se for MCC, expande sub-contas via customer_client
      if (selfIsMcc) {
        const exp = await gaqlSearch(
          cid,
          cid,
          `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.status IN ('ENABLED', 'SUSPENDED')`,
        );
        const results = exp.json?.results ?? [];
        console.log(`[oauth-callback] mcc ${cid} expanded -> ${results.length} clients`);
        for (const r of results) {
          const cc = r.customerClient;
          if (!cc) continue;
          const subId = String(cc.id);
          if (subId === cid) continue;
          enriched.push({
            cid: subId,
            name: cc.descriptiveName ?? `Conta ${subId}`,
            currency: cc.currencyCode ?? null,
            isMcc: !!cc.manager,
            loginCustomerId: cid,
          });
        }
      }
    }

    // 5) Salva no banco
    let savedCount = 0;
    if (userId && enriched.length > 0) {
      const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      for (const c of enriched) {
        const { error } = await admin
          .from("google_accounts")
          .upsert(
            {
              user_id: userId,
              customer_id: c.cid,
              account_name: c.name,
              descriptive_name: c.name,
              currency: c.currency,
              is_mcc: c.isMcc,
              login_customer_id: c.loginCustomerId,
              manager_account_id: null,
              refresh_token: tokens.refresh_token,
              api_set: apiSet,
              status: "connected",
              last_synced_at: new Date().toISOString(),
            },
            { onConflict: "user_id,customer_id" },
          );
        if (error) console.error("[oauth-callback] upsert error", error);
        else savedCount++;
      }
    }

    return json({
      ok: true,
      accessible_customers: enriched,
      saved_count: savedCount,
      requires_login: !userId,
      message: userId
        ? `Conectado. ${savedCount} conta(s) salva(s). Agora clique em "Sincronizar campanhas".`
        : "Token recebido, mas é preciso estar logado para salvar.",
    });
  } catch (e) {
    console.error("[oauth-callback] uncaught error", e);
    return json({ error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : null }, 400);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
