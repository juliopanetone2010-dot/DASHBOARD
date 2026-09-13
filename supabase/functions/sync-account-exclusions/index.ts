// Copia as exclusões de conta (CustomerNegativeCriterion) de UMA conta Google Ads
// de referência — a que você já configurou na mão em Ferramentas > Exclusões de
// conteúdo (sites próprios excluídos, categorias de app excluídas etc.) — pra
// TODAS as outras contas do usuário (ou pra uma lista específica de contas novas).
//
// Não hardcoda nenhuma categoria/site: só lê o que já está configurado na conta
// de origem via GAQL e recria a mesma coisa nas contas de destino. Assim funciona
// pra qualquer combinação (sites, categorias de app Google Play/Apple, canais e
// vídeos do YouTube) sem depender de eu saber os IDs de categoria de cor.
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

// Reconstrói o "create" a partir da linha da conta de origem, preservando só o
// sub-campo que o type indica (placement / mobileApplication / mobileAppCategory /
// youtubeChannel / youtubeVideo) — os mesmos formatos que campaignCriteria já usa
// em placements-cleanup, só que sem "campaign"/"negative" (CustomerNegativeCriterion
// já é implicitamente negativo e de conta).
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const sourceAccountId = typeof (body as any)?.source_account_id === "string" ? (body as any).source_account_id : null;
    const sourceCustomerId = typeof (body as any)?.source_customer_id === "string" ? String((body as any).source_customer_id).replace(/\D/g, "") : null;
    const targetCustomerIds: string[] | null = Array.isArray((body as any)?.target_customer_ids)
      ? (body as any).target_customer_ids.map((x: unknown) => String(x).replace(/\D/g, "")).filter(Boolean)
      : null;
    if (!sourceAccountId && !sourceCustomerId) return json({ error: "source_account_id ou source_customer_id obrigatório" });

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: allAccounts, error: accErr } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id, api_set, account_name, descriptive_name, is_mcc")
      .eq("user_id", userId);
    if (accErr) return json({ error: accErr.message });

    const source = (allAccounts ?? []).find((a: AccRow) =>
      (sourceAccountId && a.id === sourceAccountId) || (sourceCustomerId && a.customer_id === sourceCustomerId),
    ) as AccRow | undefined;
    if (!source?.refresh_token) return json({ error: "Conta de origem não encontrada ou sem token" });

    // MCC/sub-MCC (contas gerenciadoras) não rodam campanha e rejeitam
    // CustomerNegativeCriterion — só contas operacionais entram como destino.
    let targets = (allAccounts ?? []).filter((a: any) => a.id !== source.id && a.refresh_token && a.customer_id && !a.is_mcc) as AccRow[];
    if (targetCustomerIds && targetCustomerIds.length > 0) {
      targets = targets.filter((a) => targetCustomerIds.includes(a.customer_id));
    }
    if (targets.length === 0) return json({ ok: true, message: "Nenhuma conta de destino (nada a fazer).", source: source.customer_id, targets: [] });

    // 1) Lê as exclusões já configuradas na conta de origem.
    const sourceHeaders = await authHeadersFor(source);
    const query = `
      SELECT customer_negative_criterion.type,
             customer_negative_criterion.placement.url,
             customer_negative_criterion.mobile_application.app_id,
             customer_negative_criterion.mobile_app_category.mobile_app_category_constant,
             customer_negative_criterion.youtube_channel.channel_id,
             customer_negative_criterion.youtube_video.video_id
      FROM customer_negative_criterion
    `;
    const sourceRows: any[] = [];
    let pageToken: string | undefined;
    do {
      const r = await fetch(
        `https://googleads.googleapis.com/v24/customers/${source.customer_id}/googleAds:search`,
        { method: "POST", headers: sourceHeaders, body: JSON.stringify({ query, pageToken }) },
      );
      const j = await r.json();
      if (!r.ok) return json({ error: `Falha ao ler exclusões da conta de origem: ${j?.error?.message ?? JSON.stringify(j).slice(0, 300)}` });
      sourceRows.push(...(j.results ?? []));
      pageToken = j.nextPageToken || undefined;
    } while (pageToken);

    const operations = sourceRows.map((r) => buildCreateFromRow(r)).filter(Boolean).map((create) => ({ create }));
    if (operations.length === 0) {
      return json({ ok: true, message: "A conta de origem não tem nenhuma exclusão configurada.", source: source.customer_id, operations: 0, targets: [] });
    }

    // 2) Replica em cada conta de destino, isolada em try/catch (uma conta com
    // problema não pode travar as outras — mesma lição do placements-cleanup).
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
        // Sem partial failure: tudo que foi enviado foi criado. Com partial failure,
        // cada índice sem resourceName falhou — na prática quase sempre porque a
        // exclusão já existia de uma tentativa anterior (duplicate_criterion).
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

    return json({
      ok: true,
      source: source.customer_id,
      operations: operations.length,
      total_targets: targets.length,
      succeeded_accounts: succeededAccounts,
      failed_accounts: failedAccounts.length,
      details: results,
    });
  } catch (e) {
    console.error("[sync-account-exclusions]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});
