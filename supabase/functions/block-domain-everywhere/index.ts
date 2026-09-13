// Bloqueia (ou desbloqueia) um domínio/placement em TODAS as contas Google Ads do
// usuário de uma vez, via CustomerNegativeCriterion (exclusão em nível de CONTA —
// não de campanha). body.mode: "block" (padrão) cria a exclusão; "unblock" acha e
// remove a exclusão existente daquele domínio em cada conta.
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
    const mode: "block" | "unblock" = (body as any)?.mode === "unblock" ? "unblock" : "block";

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

        if (mode === "unblock") {
          // Acha o(s) resourceName(s) da exclusão desse domínio nessa conta (pode ter
          // sido criado com/sem "https://"/"www." em algum momento — busca tudo do
          // tipo placement e filtra pelo domínio no cliente pra pegar qualquer variante).
          const searchRes = await fetch(
            `https://googleads.googleapis.com/v24/customers/${acc.customer_id}/googleAds:search`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                query: `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.placement.url
                        FROM customer_negative_criterion
                        WHERE customer_negative_criterion.type = 'PLACEMENT'`,
              }),
            },
          );
          const sj = await searchRes.json();
          if (!searchRes.ok) return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: sj?.error?.message ?? JSON.stringify(sj).slice(0, 300) };
          const matches = (sj.results ?? []).filter((row: any) => {
            const url = String(row?.customerNegativeCriterion?.placement?.url ?? "");
            return normalizeDomain(url) === domain;
          });
          if (matches.length === 0) return { account_id: acc.id, customer_id: acc.customer_id, label, ok: true, not_blocked: true };

          const r2 = await fetch(
            `https://googleads.googleapis.com/v24/customers/${acc.customer_id}/customerNegativeCriteria:mutate`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                operations: matches.map((row: any) => ({ remove: row.customerNegativeCriterion.resourceName })),
                partialFailure: true,
              }),
            },
          );
          const j2 = await r2.json();
          if (!r2.ok) return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: j2?.error?.message ?? JSON.stringify(j2).slice(0, 300) };
          if (j2?.partialFailureError) {
            return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: j2.partialFailureError?.message ?? JSON.stringify(j2.partialFailureError).slice(0, 300) };
          }
          return { account_id: acc.id, customer_id: acc.customer_id, label, ok: true, removed: matches.length };
        }

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

    const blocked = mode === "block" ? results.filter((r: any) => r.ok && !r.already_blocked).length : 0;
    const alreadyBlocked = mode === "block" ? results.filter((r: any) => r.ok && r.already_blocked).length : 0;
    const removed = mode === "unblock" ? results.filter((r: any) => r.ok && r.removed).reduce((a: number, r: any) => a + r.removed, 0) : 0;
    const notBlocked = mode === "unblock" ? results.filter((r: any) => r.ok && r.not_blocked).length : 0;
    const failed = results.filter((r) => !r.ok);

    // Log de auditoria — não trava a resposta se falhar.
    try {
      await admin.from("automation_actions").insert(
        results.map((r: any) => ({
          user_id: userId,
          campaign_id: "__account__",
          action_type: mode === "unblock" ? "negative_placement_account_wide_removed" : "negative_placement_account_wide",
          payload: { domain, mode, google_account_id: r.account_id, customer_id: r.customer_id, label: r.label, already_blocked: !!r.already_blocked, removed: r.removed ?? 0, not_blocked: !!r.not_blocked },
          status: r.ok ? (r.already_blocked || r.not_blocked ? "no_op" : "executed") : "failed",
          error: r.ok ? null : (r.error ?? null),
          executed_at: new Date().toISOString(),
        })),
      );
    } catch (_e) { /* auditoria não é crítica */ }

    return json({
      ok: true,
      mode,
      domain,
      total_accounts: withToken.length,
      blocked,
      already_blocked: alreadyBlocked,
      removed,
      not_blocked: notBlocked,
      failed: failed.length,
      details: results,
    });
  } catch (e) {
    console.error("[block-domain-everywhere]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});
