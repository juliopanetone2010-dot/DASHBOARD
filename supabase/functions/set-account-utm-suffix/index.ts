// Define o "Sufixo do URL final" (final_url_suffix) A NÍVEL DE CONTA — não de
// campanha. Diferente de google-ads-apply-utm-bulk (que seta em cada CAMPANHA já
// existente), isto seta o PADRÃO DA CONTA: toda campanha nova criada depois disso
// herda o sufixo automaticamente, sem precisar preencher aquele campo na hora de
// subir. Campanha que já tem um sufixo próprio preenchido continua usando o dela —
// o valor da conta só vale pra quem está vazio.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getAccessTokenFor, devTokenFor } from "../_shared/google_api_set.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const DEFAULT_SUFFIX = [
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
    const suffix = String((body as any)?.suffix ?? "").trim() || DEFAULT_SUFFIX;
    const accountIds: string[] | null = Array.isArray((body as any)?.account_ids) && (body as any).account_ids.length
      ? (body as any).account_ids
      : null;

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let q = admin.from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id, api_set, account_name, descriptive_name, is_mcc")
      .eq("user_id", userId);
    if (accountIds) q = q.in("id", accountIds);
    const { data: accounts, error: accErr } = await q;
    if (accErr) return json({ error: accErr.message });

    // MCC em si não roda campanha — só as contas operacionais fazem sentido aqui.
    const targets = (accounts ?? []).filter((a: any) => a.refresh_token && a.customer_id && !a.is_mcc);
    if (targets.length === 0) return json({ error: "Nenhuma conta operacional (não-MCC) encontrada" });

    const results = await Promise.all(targets.map(async (acc: any) => {
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

        // CustomerService.MutateCustomer: 1 operação só (não é uma lista de
        // operations como campaignCriteria/customerNegativeCriteria).
        const r = await fetch(
          `https://googleads.googleapis.com/v24/customers/${acc.customer_id}:mutate`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              operation: {
                update: { resourceName: `customers/${acc.customer_id}`, finalUrlSuffix: suffix },
                updateMask: "final_url_suffix",
              },
            }),
          },
        );
        const j = await r.json();
        if (!r.ok) return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: j?.error?.message ?? JSON.stringify(j).slice(0, 300) };
        return { account_id: acc.id, customer_id: acc.customer_id, label, ok: true };
      } catch (e) {
        return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    }));

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);

    try {
      await admin.from("automation_actions").insert(
        results.map((r: any) => ({
          user_id: userId,
          campaign_id: "__account__",
          action_type: "account_utm_suffix_set",
          payload: { suffix, google_account_id: r.account_id, customer_id: r.customer_id, label: r.label },
          status: r.ok ? "executed" : "failed",
          error: r.ok ? null : (r.error ?? null),
          executed_at: new Date().toISOString(),
        })),
      );
    } catch (_e) { /* auditoria não é crítica */ }

    return json({
      ok: true,
      suffix,
      total_accounts: targets.length,
      succeeded_accounts: succeeded,
      failed_accounts: failed.length,
      details: results,
    });
  } catch (e) {
    console.error("[set-account-utm-suffix]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});
