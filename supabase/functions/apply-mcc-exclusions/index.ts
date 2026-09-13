// Um botão só: bloqueia (CustomerNegativeCriterion — exclusão em nível de CONTA) em
// TODAS as contas Google Ads do usuário:
//   1) todos os SITES próprios (tabela `sites`, campo domain) — não faz sentido
//      anunciar em cima do seu próprio inventário monetizado;
//   2) tudo mais que já estiver excluído numa conta de REFERÊNCIA (opcional) —
//      normalmente categorias de app da Play Store/App Store que o usuário já
//      configurou na mão em Ferramentas > Exclusões de conteúdo.
// Não hardcoda nenhuma categoria de app: só lê o que já existe na conta de
// referência e replica. Cada conta de destino é isolada em try/catch — uma conta
// com problema não pode travar as outras.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getAccessTokenFor, devTokenFor } from "../_shared/google_api_set.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface AccRow {
  id: string;
  customer_id: string;
  refresh_token: string | null;
  login_customer_id: string | null;
  api_set: number | null;
  account_name: string | null;
  descriptive_name: string | null;
}

async function authHeadersFor(acc: AccRow) {
  const apiSet = acc.api_set ?? 1;
  const accessToken = await getAccessTokenFor(acc.refresh_token!, apiSet);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": devTokenFor(apiSet),
    "Content-Type": "application/json",
  };
  if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;
  return headers;
}

function buildCreateFromRow(row: any): Record<string, unknown> | null {
  const c = row?.customerNegativeCriterion;
  if (!c) return null;
  if (c.placement?.url) return { placement: { url: c.placement.url } };
  if (c.mobileApplication?.appId) return { mobileApplication: { appId: c.mobileApplication.appId } };
  if (c.mobileAppCategory?.mobileAppCategoryConstant) {
    return { mobileAppCategory: { mobileAppCategoryConstant: c.mobileAppCategory.mobileAppCategoryConstant } };
  }
  if (c.youtubeChannel?.channelId) return { youtubeChannel: { channelId: c.youtubeChannel.channelId } };
  if (c.youtubeVideo?.videoId) return { youtubeVideo: { videoId: c.youtubeVideo.videoId } };
  return null;
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
    const sourceAccountId = typeof (body as any)?.source_account_id === "string" && (body as any).source_account_id
      ? (body as any).source_account_id
      : null;

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const [{ data: sites, error: sitesErr }, { data: allAccounts, error: accErr }] = await Promise.all([
      admin.from("sites").select("domain").eq("user_id", userId),
      admin.from("google_accounts")
        .select("id, customer_id, refresh_token, login_customer_id, api_set, account_name, descriptive_name")
        .eq("user_id", userId),
    ]);
    if (sitesErr) return json({ error: sitesErr.message });
    if (accErr) return json({ error: accErr.message });

    const siteDomains = [...new Set((sites ?? []).map((s: any) => normalizeDomain(String(s.domain ?? ""))).filter((d) => d && d.includes(".")))];
    const targets = (allAccounts ?? []).filter((a: AccRow) => a.refresh_token && a.customer_id) as AccRow[];
    if (targets.length === 0) return json({ error: "Nenhuma conta Ads conectada" });

    // Operações base: um "create" de placement por site próprio.
    const operations: Array<{ create: Record<string, unknown> }> = siteDomains.map((d) => ({
      create: { placement: { url: `https://${d}` } },
    }));

    // Se tiver conta de referência, soma tudo que já está configurado nela
    // (normalmente categorias de app) — duplicatas com os sites acima não
    // causam problema, viram no-op na conta de destino.
    let sourceLabel: string | null = null;
    if (sourceAccountId) {
      const source = (allAccounts ?? []).find((a: AccRow) => a.id === sourceAccountId) as AccRow | undefined;
      if (source?.refresh_token) {
        sourceLabel = source.account_name || source.descriptive_name || source.customer_id;
        const headers = await authHeadersFor(source);
        const query = `
          SELECT customer_negative_criterion.type,
                 customer_negative_criterion.placement.url,
                 customer_negative_criterion.mobile_application.app_id,
                 customer_negative_criterion.mobile_app_category.mobile_app_category_constant,
                 customer_negative_criterion.youtube_channel.channel_id,
                 customer_negative_criterion.youtube_video.video_id
          FROM customer_negative_criterion
        `;
        let pageToken: string | undefined;
        const sourceRows: any[] = [];
        do {
          const r = await fetch(
            `https://googleads.googleapis.com/v24/customers/${source.customer_id}/googleAds:search`,
            { method: "POST", headers, body: JSON.stringify({ query, pageToken }) },
          );
          const j = await r.json();
          if (!r.ok) return json({ error: `Falha ao ler exclusões da conta de referência: ${j?.error?.message ?? JSON.stringify(j).slice(0, 300)}` });
          sourceRows.push(...(j.results ?? []));
          pageToken = j.nextPageToken || undefined;
        } while (pageToken);
        for (const row of sourceRows) {
          const create = buildCreateFromRow(row);
          if (create) operations.push({ create });
        }
      }
    }

    if (operations.length === 0) {
      return json({ ok: true, message: "Nenhum site cadastrado e nenhuma conta de referência com exclusões — nada a aplicar.", operations: 0 });
    }

    const results = await Promise.all(targets.map(async (acc) => {
      const label = acc.account_name || acc.descriptive_name || acc.customer_id;
      try {
        const headers = await authHeadersFor(acc);
        const r = await fetch(
          `https://googleads.googleapis.com/v24/customers/${acc.customer_id}/customerNegativeCriteria:mutate`,
          { method: "POST", headers, body: JSON.stringify({ operations, partialFailure: true }) },
        );
        const j = await r.json();
        if (!r.ok) return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: j?.error?.message ?? JSON.stringify(j).slice(0, 300) };

        const partial = j?.partialFailureError;
        const failedIdx = new Set<number>();
        if (partial?.details?.length) {
          for (const d of partial.details) {
            for (const err of d?.errors ?? []) {
              for (const p of err?.location?.fieldPathElements ?? []) {
                if (typeof p?.index === "number") failedIdx.add(p.index);
              }
            }
          }
        }
        const results_ = j?.results ?? [];
        let created = 0, already = 0;
        operations.forEach((_op, idx) => {
          const succeeded = !partial || (results_[idx]?.resourceName && !failedIdx.has(idx));
          if (succeeded) created++; else already++;
        });
        return { account_id: acc.id, customer_id: acc.customer_id, label, ok: true, created, already };
      } catch (e) {
        return { account_id: acc.id, customer_id: acc.customer_id, label, ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    }));

    const succeededAccounts = results.filter((r) => r.ok).length;
    const failedAccounts = results.filter((r) => !r.ok);

    try {
      await admin.from("automation_actions").insert(
        results.map((r: any) => ({
          user_id: userId,
          campaign_id: "__account__",
          action_type: "mcc_exclusions_applied",
          payload: { site_domains: siteDomains, source_account: sourceLabel, google_account_id: r.account_id, customer_id: r.customer_id, label: r.label, created: r.created ?? 0, already: r.already ?? 0 },
          status: r.ok ? "executed" : "failed",
          error: r.ok ? null : (r.error ?? null),
          executed_at: new Date().toISOString(),
        })),
      );
    } catch (_e) { /* auditoria não é crítica */ }

    return json({
      ok: true,
      site_domains: siteDomains,
      source_account: sourceLabel,
      operations: operations.length,
      total_accounts: targets.length,
      succeeded_accounts: succeededAccounts,
      failed_accounts: failedAccounts.length,
      details: results,
    });
  } catch (e) {
    console.error("[apply-mcc-exclusions]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});
