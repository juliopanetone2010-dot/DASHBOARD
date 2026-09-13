// Bloqueia um domínio/placement em TODAS as contas Google Ads do usuário de uma vez,
// via CustomerNegativeCriterion (exclusão em nível de CONTA — não de campanha).
// Diferença pro fluxo de placements-cleanup: lá cada exclusão é por campanha
// (CampaignCriterion); aqui é uma exclusão só, que vale pra toda campanha ATUAL e
// FUTURA daquela conta. É o equivalente ao "Content exclusions" / exclusão de conta
// que existe na UI do Google Ads, só que via API pra cobrir todas as contas de uma vez.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getAccessTokenFor, devTokenFor } from "../_shared/google_api_set.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function normalizeDomain(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const rawDomain = String((body as any)?.domain ?? "").trim();
    if (!rawDomain) return json({ error: "domain obrigatório" });
    const domain = normalizeDomain(rawDomain);
    if (!domain || !domain.includes(".")) return json({ error: `domain inválido: "${rawDomain}"` });

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: accounts, error: accErr } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id, api_set, account_name, descriptive_name")
      .eq("user_id", userId);
    if (accErr) return json({ error: accErr.message });
    const withToken = (accounts ?? []).filter((a: any) => a.refresh_token && a.customer_id);
    if (withToken.length === 0) return json({ error: "Nenhuma conta Ads conectada" });

    const results = await Promise.all(withToken.map(async (acc: any) => {
      const label = acc.account_name || acc.descriptive_name || acc.customer_id;
      try {
        const apiSet = acc.api_set ?? 1;
        const accessToken = await getAccessTokenFor(acc.refresh_token, apiSet);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devTokenFor(apiSet),
          "Content-Type": "application/json",
        };
        if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;

        const r = await fetch(
          `https://googleads.googleapis.com/v24/customers/${acc.customer_id}/customerNegativeCriteria:mutate`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              operations: [{ create: { placement: { url: `https://${domain}` } } }],
              partialFailure: true,
            }),
          },
        );
        const j = await r.json();
        const raw = JSON.stringify(j);
        const isDuplicate = raw.includes("DUPLICATE_CRITERION") || raw.includes("DUPLICATE_MATERIALIZED_CRITERION");
        if (!r.ok) {
          if (isDuplicate) return { account_id: acc.id, customer_id: acc.customer_id, label, ok: true, already_blocked: true };
          return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: j?.error?.message ?? raw.slice(0, 300) };
        }
        const partial = j?.partialFailureError;
        if (partial) {
          const praw = JSON.stringify(partial);
          if (praw.includes("DUPLICATE_CRITERION") || praw.includes("DUPLICATE_MATERIALIZED_CRITERION")) {
            return { account_id: acc.id, customer_id: acc.customer_id, label, ok: true, already_blocked: true };
          }
          return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: partial?.message ?? praw.slice(0, 300) };
        }
        return { account_id: acc.id, customer_id: acc.customer_id, label, ok: true, already_blocked: false };
      } catch (e) {
        return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    }));

    const blocked = results.filter((r) => r.ok && !r.already_blocked).length;
    const alreadyBlocked = results.filter((r) => r.ok && r.already_blocked).length;
    const failed = results.filter((r) => !r.ok);

    // Log de auditoria — não trava a resposta se falhar.
    try {
      await admin.from("automation_actions").insert(
        results.map((r) => ({
          user_id: userId,
          campaign_id: "__account__",
          action_type: "negative_placement_account_wide",
          payload: { domain, google_account_id: r.account_id, customer_id: r.customer_id, label: r.label, already_blocked: !!r.already_blocked },
          status: r.ok ? (r.already_blocked ? "already_blocked" : "executed") : "failed",
          error: r.ok ? null : (r.error ?? null),
          executed_at: new Date().toISOString(),
        })),
      );
    } catch (_e) { /* auditoria não é crítica */ }

    return json({
      ok: true,
      domain,
      total_accounts: withToken.length,
      blocked,
      already_blocked: alreadyBlocked,
      failed: failed.length,
      details: results,
    });
  } catch (e) {
    console.error("[block-domain-everywhere]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});
