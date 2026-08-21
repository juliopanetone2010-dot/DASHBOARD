import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getCreds, tryGetCreds } from "../_shared/google_api_set.ts";

interface SyncBody {
  manager_account_id?: string;
  api_set?: number;
  force_all?: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Login obrigatório" }, 401);
    }

    if (!tryGetCreds(1) && !tryGetCreds(2) && !tryGetCreds(3) && !tryGetCreds(4) && !tryGetCreds(5)) {
      return json({ error: "Nenhuma credencial Google Ads configurada nos Secrets" }, 500);
    }

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = (await req.json().catch(() => ({}))) as SyncBody;

    let q = admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, account_name, api_set")
      .eq("user_id", userId)
      .eq("is_mcc", true)
      .not("refresh_token", "is", null);

    if (body.api_set) {
      q = q.eq("api_set", body.api_set);
    } else if (!body.force_all) {
      q = q.eq("api_set", 1);
    }

    if (body.manager_account_id) q = q.eq("id", body.manager_account_id);
    const { data: managers, error: mErr } = await q;
    if (mErr) return json({ error: mErr.message }, 500);
    if (!managers || managers.length === 0) {
      return json({ ok: true, summary: [], message: "Nenhum MCC conectado encontrado." });
    }

    const summary: Array<{ manager: string; synced: number; error?: string }> = [];

    for (const mgr of managers) {
      const mgrCreds = getCreds((mgr as any).api_set ?? 1);
      try {
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: mgrCreds.clientId,
            client_secret: mgrCreds.clientSecret,
            refresh_token: mgr.refresh_token!,
            grant_type: "refresh_token",
          }),
        });
        const tokenJson = await tokenRes.json();
        if (!tokenRes.ok || !tokenJson.access_token) {
          summary.push({ manager: mgr.customer_id, synced: 0, error: "refresh failed" });
          continue;
        }
        const accessToken: string = tokenJson.access_token;

        // GAQL search recursive to get all hierarchy level by level or via level attribute
        const query = `
          SELECT
            customer_client.id,
            customer_client.descriptive_name,
            customer_client.currency_code,
            customer_client.manager,
            customer_client.status,
            customer_client.level,
            customer_client.test_account
          FROM customer_client
          WHERE customer_client.status = 'ENABLED'
        `;

        const searchRes = await fetch(
          `https://googleads.googleapis.com/v24/customers/${mgr.customer_id}/googleAds:search`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "developer-token": mgrCreds.devToken,
              "login-customer-id": mgr.customer_id,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query }),
          },
        );
        const searchJson = await searchRes.json();
        if (!searchRes.ok) {
          summary.push({
            manager: mgr.customer_id,
            synced: 0,
            error: searchJson?.error?.message ?? "search failed",
          });
          continue;
        }

        const rows: any[] = searchJson.results ?? [];

        let synced = 0;
        for (const r of rows) {
          const cc = r.customerClient;
          if (!cc) continue;
          
          const childCid = String(cc.id);
          
          // Upsert ALL accounts found in the hierarchy tree
          // If it's a manager, we keep its refresh token for future listing if needed
          const isManager = cc.manager ?? false;

          const { error } = await admin
            .from("google_accounts")
            .upsert(
              {
                user_id: userId,
                customer_id: childCid,
                login_customer_id: mgr.customer_id,
                manager_account_id: mgr.id,
                account_name: cc.descriptiveName ?? (isManager ? `MCC ${childCid}` : `Conta ${childCid}`),
                descriptive_name: cc.descriptiveName ?? null,
                currency: cc.currencyCode ?? null,
                is_mcc: isManager,
                status: 'connected',
                refresh_token: mgr.refresh_token,
                api_set: (mgr as any).api_set ?? 1,
                last_synced_at: new Date().toISOString(),
              },
              { onConflict: "user_id,customer_id" },
            );
          if (!error) synced++;
        }
        summary.push({ manager: mgr.customer_id, synced });
      } catch (e) {
        summary.push({ manager: mgr.customer_id, synced: 0, error: String(e) });
      }
    }

    return json({ ok: true, summary });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}