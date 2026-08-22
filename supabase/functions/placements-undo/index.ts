// Desfaz negativações de placements aplicadas em campanhas (Google Ads).
// Body: { items: [{ campaign_id, google_account_id, placement }] }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { devTokenFor, getCreds } from "../_shared/google_api_set.ts";

interface Item {
  campaign_id: string;
  google_account_id: string;
  placement: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Login obrigatório" }, 401);
    const body = await req.json().catch(() => ({}));
    const items: Item[] = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) return json({ error: "items vazio" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" }, 401);

    const accIds = [...new Set(items.map((i) => i.google_account_id))];
    const { data: accs } = await admin
      .from("google_accounts").select("id, customer_id, login_customer_id, refresh_token, api_set")
      .eq("user_id", userId).in("id", accIds);
    const accMap = new Map<string, any>((accs ?? []).map((a: any) => [a.id, a]));

    // Agrupa por (acc, campaign)
    const groups = new Map<string, { acc: any; campaign_id: string; placements: string[] }>();
    for (const it of items) {
      const acc = accMap.get(it.google_account_id);
      if (!acc?.refresh_token) continue;
      const k = `${it.google_account_id}|${it.campaign_id}`;
      const g = groups.get(k) ?? { acc, campaign_id: it.campaign_id, placements: [] };
      const p = it.placement.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
      if (!g.placements.includes(p)) g.placements.push(p);
      groups.set(k, g);
    }

    const tokenCache = new Map<string, string>();
    const out: any[] = [];
    let removed = 0, failed = 0;

    for (const g of groups.values()) {
      try {
        const token = await getGoogleToken(g.acc.refresh_token, tokenCache, (g.acc as any).api_set ?? 1);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          "developer-token": devTokenFor((g.acc as any).api_set ?? 1),
          "Content-Type": "application/json",
        };
        if (g.acc.login_customer_id) headers["login-customer-id"] = g.acc.login_customer_id;

        // Busca os campaign_criteria negativos da campanha
        const query = `SELECT campaign_criterion.resource_name, campaign_criterion.placement.url, campaign_criterion.mobile_application.app_id, campaign_criterion.type, campaign_criterion.negative FROM campaign_criterion WHERE campaign.id = ${g.campaign_id} AND campaign_criterion.negative = TRUE AND campaign_criterion.type IN ('PLACEMENT','MOBILE_APPLICATION')`;
        const sr = await fetch(
          `https://googleads.googleapis.com/v19/customers/${g.acc.customer_id}/googleAds:search`,
          { method: "POST", headers, body: JSON.stringify({ query }) },
        );
        const sj = await sr.json();
        if (!sr.ok) {
          console.error("[undo] search err", g.campaign_id, JSON.stringify(sj));
          out.push({ campaign_id: g.campaign_id, error: sj?.error?.message ?? JSON.stringify(sj), full: sj });
          failed += g.placements.length;
          continue;
        }
        const results = sj?.results ?? [];
        const operations: any[] = [];
        const matchedPlacements: string[] = [];
        for (const p of g.placements) {
          for (const r of results) {
            const c = r?.campaignCriterion;
            if (!c?.resourceName) continue;
            const url = (c?.placement?.url ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
            const appId = (c?.mobileApplication?.appId ?? "").toLowerCase();
            if (url === p || appId.endsWith(p)) {
              operations.push({ remove: c.resourceName });
              matchedPlacements.push(p);
            }
          }
        }
        if (operations.length === 0) {
          // Nada no Ads para remover; ainda assim limpa marcação local
          out.push({ campaign_id: g.campaign_id, removed: 0, note: "no_negative_found" });
        } else {
          const mr = await fetch(
            `https://googleads.googleapis.com/v19/customers/${g.acc.customer_id}/campaignCriteria:mutate`,
            { method: "POST", headers, body: JSON.stringify({ operations, partialFailure: true }) },
          );
          const mj = await mr.json();
          if (!mr.ok) {
            out.push({ campaign_id: g.campaign_id, error: mj?.error?.message ?? JSON.stringify(mj) });
            failed += g.placements.length;
            continue;
          }
          removed += operations.length;
          out.push({ campaign_id: g.campaign_id, removed: operations.length });
        }

        // Limpa registros locais de blacklist
        await admin
          .from("placement_actions")
          .delete()
          .eq("user_id", userId)
          .eq("campaign_id", g.campaign_id)
          .eq("action", "blacklist")
          .in("placement", g.placements);

        // Marca placement_status como 'test' (volta para esteira)
        await admin
          .from("placement_status")
          .update({ status: "test", phase: "phase1_test", reason: "manual undo", blocked_at: null })
          .eq("user_id", userId)
          .eq("campaign_id", g.campaign_id)
          .in("placement", g.placements);
      } catch (e) {
        failed += g.placements.length;
        out.push({ campaign_id: g.campaign_id, error: String(e instanceof Error ? e.message : e) });
      }
    }

    return json({ ok: true, removed, failed, details: out });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}

async function getGoogleToken(refreshToken: string, cache: Map<string, string>, apiSet: unknown = 1) {
  const { clientId, clientSecret } = getCreds(apiSet);
  if (cache.has(refreshToken)) return cache.get(refreshToken)!;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
  cache.set(refreshToken, j.access_token);
  return j.access_token as string;
}
