// Aplica final_url_suffix com UTM padrão em TODAS as campanhas (ou filtradas) do usuário.
// Padrão: utm_source=google&utm_campaign={campaignid}&utm_adgroup={adgroupid}&utm_content={creative}&utm_placement={campaignid}_{placement}
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { devTokenFor, getCreds, normalizeApiSet } from "../_shared/google_api_set.ts";

const SUFFIX = [
  "utm_source=google",
  "utm_campaign={campaignid}",
  "utm_adgroup={adgroupid}",
  "utm_content={creative}",
  "utm_placement={campaignid}_{placement}",
].join("&");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const accountIds: string[] = Array.isArray((body as any)?.account_ids) ? (body as any).account_ids : [];
    const campaignIds: string[] = Array.isArray((body as any)?.campaign_ids) ? (body as any).campaign_ids : [];

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let q = admin.from("campaigns")
      .select("campaign_id, name, google_account_id")
      .eq("user_id", userId);
    if (accountIds.length) q = q.in("google_account_id", accountIds);
    if (campaignIds.length) q = q.in("campaign_id", campaignIds);
    const { data: campaigns, error: cErr } = await q;
    if (cErr) return json({ error: cErr.message });
    if (!campaigns?.length) return json({ error: "Nenhuma campanha encontrada" });

    // Agrupa por google_account_id
    const byAcc = new Map<string, typeof campaigns>();
    for (const c of campaigns) {
      if (!c.google_account_id) continue;
      const list = byAcc.get(c.google_account_id) ?? [];
      list.push(c);
      byAcc.set(c.google_account_id, list);
    }


    let totalOk = 0;
    let totalFail = 0;
    const errors: any[] = [];

    for (const [accId, camps] of byAcc) {
      const { data: acc } = await admin.from("google_accounts")
        .select("customer_id, refresh_token, login_customer_id, account_name, api_set")
        .eq("id", accId).maybeSingle();
      if (!acc?.refresh_token) { totalFail += camps.length; errors.push({ account_id: accId, error: "sem refresh_token" }); continue; }

      let clientId: string, clientSecret: string, devToken: string;
      try {
        ({ clientId, clientSecret, devToken } = getCreds((acc as any).api_set ?? 1));
      } catch (e) {
        totalFail += camps.length; errors.push({ account_id: accId, error: String(e) }); continue;
      }

      const tokRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret,
          refresh_token: acc.refresh_token, grant_type: "refresh_token",
        }),
      });
      const tokJson = await tokRes.json();
      if (!tokRes.ok) { totalFail += camps.length; errors.push({ account: acc.account_name, error: "refresh failed" }); continue; }
      const accessToken = tokJson.access_token as string;

      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": devToken,
        "Content-Type": "application/json",
      };
      if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;

      // mutate em lote (até 100 por chamada por segurança)
      const CHUNK = 100;
      for (let i = 0; i < camps.length; i += CHUNK) {
        const slice = camps.slice(i, i + CHUNK);
        const mutateBody = {
          operations: slice.map((c) => ({
            update: {
              resourceName: `customers/${acc.customer_id}/campaigns/${c.campaign_id}`,
              finalUrlSuffix: SUFFIX,
            },
            updateMask: "final_url_suffix",
          })),
          partialFailure: true,
        };
        const r = await fetch(
          `https://googleads.googleapis.com/v24/customers/${acc.customer_id}/campaigns:mutate`,
          { method: "POST", headers, body: JSON.stringify(mutateBody) },
        );
        const j = await r.json();
        if (!r.ok) {
          totalFail += slice.length;
          errors.push({ account: acc.account_name, error: j?.error?.message ?? JSON.stringify(j).slice(0, 300) });
          continue;
        }
        const results = (j.results ?? []) as any[];
        const partial = j.partialFailureError;
        const failedIdx = new Set<number>();
        if (partial?.details) {
          for (const d of partial.details) {
            for (const e of (d.errors ?? [])) {
              const idx = e?.location?.fieldPathElements?.[0]?.index;
              if (typeof idx === "number") failedIdx.add(idx);
            }
          }
          errors.push({ account: acc.account_name, partial: partial.message });
        }
        totalOk += results.length - failedIdx.size;
        totalFail += failedIdx.size;
      }
    }

    await admin.from("automation_actions").insert({
      user_id: userId,
      campaign_id: "BULK",
      action_type: "apply_utm_bulk",
      payload: { suffix: SUFFIX, total: campaigns.length, ok: totalOk, fail: totalFail } as any,
      status: totalFail === 0 ? "executed" : "partial",
      executed_at: new Date().toISOString(),
      error: errors.length ? JSON.stringify(errors).slice(0, 1000) : null,
    });

    return json({ ok: true, total: campaigns.length, success: totalOk, failed: totalFail, suffix: SUFFIX, errors });
  } catch (e) {
    console.error("[apply-utm-bulk] uncaught", e);
    return json({ error: String(e) });
  }
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
