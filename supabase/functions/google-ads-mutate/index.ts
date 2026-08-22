// Mutações em Google Ads:
// - set_status: pausar / ativar campanha
// - adjust_cpa: ajusta target_cpa_micros de todos os ad groups da campanha por % (delta)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { devTokenFor, getCreds, normalizeApiSet } from "../_shared/google_api_set.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const action = String((body as any)?.action ?? "");
    const campaignId = String((body as any)?.campaign_id ?? "");
    const newStatus = String((body as any)?.status ?? "").toUpperCase(); // ENABLED|PAUSED
    const deltaPct = Number((body as any)?.delta_pct ?? 0); // e.g. +10 / -10
    const requestedSiteId = typeof (body as any)?.site_id === "string" ? String((body as any).site_id) : null;
    const requestedAccountId = typeof (body as any)?.google_account_id === "string" ? String((body as any).google_account_id) : null;

    if (!campaignId) return json({ error: "campaign_id obrigatório" });
    if (!["set_status", "adjust_cpa", "apply_utm", "adjust_budget", "exclude_country", "set_ad_status", "set_target_cpa", "set_budget_absolute", "set_ad_group_cpa_absolute"].includes(action)) {
      return json({ error: "action inválida" });
    }

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const token = authHeader.replace("Bearer ", "");
    const systemUserId = req.headers.get("x-system-user-id");
    let userId: string | undefined;

    // Modo system: chamada interna do cron com service role + header x-system-user-id
    if (token === serviceRoleKey && systemUserId) {
      userId = systemUserId;
    } else {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
      );
      const { data: claims } = await userClient.auth.getClaims(token);
      userId = claims?.claims?.sub;
    }
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Localiza campanha + conta Ads (sem filtrar por dono: acesso é validado via RBAC)
    const { data: camp, error: cErr } = await admin
      .from("campaigns")
      .select("id, campaign_id, name, status, google_account_id, user_id")
      .eq("campaign_id", campaignId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cErr || !camp) return json({ error: "Campanha não encontrada" });
    if (!camp.google_account_id) return json({ error: "Campanha sem conta Ads vinculada" });
    if (requestedAccountId && requestedAccountId !== camp.google_account_id) {
      return json({ error: "Bloqueado: campanha não pertence à conta selecionada" });
    }

    const ownerId = String(camp.user_id);
    if (ownerId !== userId) {
      const { data: allowed } = await admin.rpc("can_access_campaign", {
        _uid: userId,
        _campaign_id: campaignId,
      });
      if (!allowed) return json({ error: "Acesso negado a esta campanha" });
    }

    const resolvedSiteId = await resolveCampaignSiteId(admin, ownerId, campaignId, camp.google_account_id);
    if (!resolvedSiteId) return json({ error: "Bloqueado: campanha sem site confirmado" });
    if (requestedSiteId && requestedSiteId !== resolvedSiteId) {
      return json({ error: "Bloqueado: campanha não pertence ao site selecionado" });
    }


    const { data: acc, error: aErr } = await admin
      .from("google_accounts")
      .select("customer_id, refresh_token, login_customer_id, api_set")
      .eq("id", camp.google_account_id)
      .maybeSingle();
    if (aErr || !acc?.refresh_token) return json({ error: "Conta Ads sem refresh token" });

    const { clientId, clientSecret, devToken } = getCreds(acc.api_set ?? 1);

    // Access token
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        refresh_token: acc.refresh_token, grant_type: "refresh_token",
      }),
    });
    const tokJson = await tokRes.json();
    if (!tokRes.ok) return json({ error: `refresh failed: ${JSON.stringify(tokJson)}` });
    const accessToken = tokJson.access_token as string;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": devToken,
      "Content-Type": "application/json",
    };
    if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;

    const apiBase = `https://googleads.googleapis.com/v17/customers/${acc.customer_id}`;

    // Log da ação
    const logAction = async (status: string, payload: unknown, error?: string) => {
      await admin.from("automation_actions").insert({
        user_id: userId,
        campaign_id: camp.campaign_id,
        action_type: action,
        payload: { ...(payload as any), site_id: resolvedSiteId, google_account_id: camp.google_account_id },
        status,
        executed_at: new Date().toISOString(),
        error: error ?? null,
      });
    };

    if (action === "set_status") {
      if (!["ENABLED", "PAUSED"].includes(newStatus)) {
        return json({ error: "status deve ser ENABLED ou PAUSED" });
      }
      const mutateBody = {
        operations: [{
          update: {
            resourceName: `customers/${acc.customer_id}/campaigns/${camp.campaign_id}`,
            status: newStatus,
          },
          updateMask: "status",
        }],
      };
      const r = await fetch(`${apiBase}/campaigns:mutate`, {
        method: "POST", headers, body: JSON.stringify(mutateBody),
      });
      const j = await r.json();
      if (!r.ok) {
        await logAction("failed", mutateBody, JSON.stringify(j));
        return json({ error: j?.error?.message ?? JSON.stringify(j) });
      }
      // Atualiza status no banco
      await admin.from("campaigns")
        .update({ status: newStatus.toLowerCase() })
        .eq("id", camp.id);
      await logAction("executed", mutateBody);
      return json({ ok: true, action, new_status: newStatus });
    }

    // adjust_cpa: busca ad_groups com target_cpa_micros definido e atualiza
    if (action === "adjust_cpa") {
      if (!Number.isFinite(deltaPct) || deltaPct === 0) {
        return json({ error: "delta_pct inválido" });
      }
      const query = `
        SELECT ad_group.id, ad_group.name, ad_group.target_cpa_micros, ad_group.status
        FROM ad_group
        WHERE ad_group.campaign = 'customers/${acc.customer_id}/campaigns/${camp.campaign_id}'
          AND ad_group.status != 'REMOVED'
      `;
      const sRes = await fetch(`${apiBase}/googleAds:search`, {
        method: "POST", headers, body: JSON.stringify({ query }),
      });
      const sJson = await sRes.json();
      if (!sRes.ok) {
        await logAction("failed", { query }, JSON.stringify(sJson));
        return json({ error: sJson?.error?.message ?? JSON.stringify(sJson) });
      }
      const rows = (sJson.results ?? []) as Array<{
        adGroup: { id: string; name: string; targetCpaMicros?: string };
      }>;

      const ops = rows
        .filter((r) => r.adGroup.targetCpaMicros && Number(r.adGroup.targetCpaMicros) > 0)
        .map((r) => {
          const current = Number(r.adGroup.targetCpaMicros);
          // Google Ads exige target_cpa_micros múltiplo de 10000 (billable unit = 0.01 da moeda)
          const raw = current * (1 + deltaPct / 100);
          const next = Math.max(10000, Math.round(raw / 10000) * 10000);
          return {
            update: {
              resourceName: `customers/${acc.customer_id}/adGroups/${r.adGroup.id}`,
              targetCpaMicros: String(next),
            },
            updateMask: "target_cpa_micros",
            _meta: { ad_group_id: r.adGroup.id, name: r.adGroup.name, from: current, to: next },
          };
        });

      if (ops.length === 0) {
        await logAction("skipped", { reason: "Nenhum ad_group com target_cpa configurado" });
        return json({
          error: "Nenhum ad group desta campanha tem target CPA configurado. Defina uma estratégia de lance com Target CPA primeiro.",
        });
      }

      const mutateBody = { operations: ops.map(({ _meta, ...o }) => o) };
      const meta = ops.map((o) => o._meta);
      const r = await fetch(`${apiBase}/adGroups:mutate`, {
        method: "POST", headers, body: JSON.stringify(mutateBody),
      });
      const j = await r.json();
      if (!r.ok) {
        await logAction("failed", { meta, body: mutateBody }, JSON.stringify(j));
        return json({ error: j?.error?.message ?? JSON.stringify(j) });
      }
      await logAction("executed", { delta_pct: deltaPct, ad_groups: meta });
      return json({
        ok: true, action, delta_pct: deltaPct,
        ad_groups_updated: meta.length, details: meta,
      });
    }

    // apply_utm: define final_url_suffix da campanha com o padrão UTM
    // utm_source=google&utm_campaign={campaignid}&utm_adgroup={adgroupid}&utm_content={creative}&utm_placement={campaignid}_{placement}
    if (action === "apply_utm") {
      const suffix = [
        "utm_source=google",
        "utm_campaign={campaignid}",
        "utm_adgroup={adgroupid}",
        "utm_content={creative}",
        "utm_placement={campaignid}_{placement}",
      ].join("&");

      const mutateBody = {
        operations: [{
          update: {
            resourceName: `customers/${acc.customer_id}/campaigns/${camp.campaign_id}`,
            finalUrlSuffix: suffix,
          },
          updateMask: "final_url_suffix",
        }],
      };
      const r = await fetch(`${apiBase}/campaigns:mutate`, {
        method: "POST", headers, body: JSON.stringify(mutateBody),
      });
      const j = await r.json();
      if (!r.ok) {
        await logAction("failed", mutateBody, JSON.stringify(j));
        return json({ error: j?.error?.message ?? JSON.stringify(j) });
      }
      await logAction("executed", { suffix });
      return json({ ok: true, action, suffix });
    }

    // adjust_budget: ajusta o campaign_budget vinculado à campanha em deltaPct (%)
    if (action === "adjust_budget") {
      if (!Number.isFinite(deltaPct) || deltaPct === 0) {
        return json({ error: "delta_pct inválido" });
      }
      // Busca o budget atual da campanha
      const query = `
        SELECT campaign.id, campaign.campaign_budget, campaign_budget.id, campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.id = ${camp.campaign_id}
      `;
      const sRes = await fetch(`${apiBase}/googleAds:search`, {
        method: "POST", headers, body: JSON.stringify({ query }),
      });
      const sJson = await sRes.json();
      if (!sRes.ok) {
        await logAction("failed", { query }, JSON.stringify(sJson));
        return json({ error: sJson?.error?.message ?? JSON.stringify(sJson) });
      }
      const row = (sJson.results ?? [])[0] as { campaignBudget?: { id?: string; amountMicros?: string } } | undefined;
      const budgetId = row?.campaignBudget?.id;
      const currentMicros = Number(row?.campaignBudget?.amountMicros ?? 0);
      if (!budgetId || currentMicros <= 0) {
        await logAction("skipped", { reason: "Sem budget vinculado" });
        return json({ error: "Campanha sem orçamento configurado" });
      }
      // Google Ads exige que amount_micros seja múltiplo de 10.000 (unidade mínima da moeda)
      const rawNext = currentMicros * (1 + deltaPct / 100);
      const nextMicros = Math.max(10_000, Math.round(rawNext / 10_000) * 10_000);
      const mutateBody = {
        operations: [{
          update: {
            resourceName: `customers/${acc.customer_id}/campaignBudgets/${budgetId}`,
            amountMicros: String(nextMicros),
          },
          updateMask: "amount_micros",
        }],
      };
      const r = await fetch(`${apiBase}/campaignBudgets:mutate`, {
        method: "POST", headers, body: JSON.stringify(mutateBody),
      });
      const j = await r.json();
      if (!r.ok) {
        await logAction("failed", { meta: { budgetId, currentMicros, nextMicros }, body: mutateBody }, JSON.stringify(j));
        return json({ error: j?.error?.message ?? JSON.stringify(j) });
      }
      await admin.from("campaigns").update({ budget_micros: nextMicros }).eq("id", camp.id);
      await logAction("executed", { delta_pct: deltaPct, budget_id: budgetId, from: currentMicros, to: nextMicros });
      return json({
        ok: true, action, delta_pct: deltaPct,
        budget_from: currentMicros / 1_000_000,
        budget_to: nextMicros / 1_000_000,
      });
    }

    // exclude_country:
    // 1) Se já existe critério POSITIVO desse país => remove (assim para de mirar nele)
    // 2) Senão => cria critério NEGATIVO (location exclusion)
    if (action === "exclude_country") {
      const countryCriterionId = String((body as any)?.country_criterion_id ?? "").replace(/\D/g, "");
      if (!countryCriterionId) return json({ error: "country_criterion_id obrigatório" });

      const geoRN = `geoTargetConstants/${countryCriterionId}`;
      const campaignRN = `customers/${acc.customer_id}/campaigns/${camp.campaign_id}`;

      // Procura critério existente para esse país nessa campanha
      const searchBody = {
        query: `SELECT campaign_criterion.resource_name, campaign_criterion.negative, campaign_criterion.location.geo_target_constant
                FROM campaign_criterion
                WHERE campaign.id = ${camp.campaign_id}
                  AND campaign_criterion.type = 'LOCATION'
                  AND campaign_criterion.location.geo_target_constant = '${geoRN}'`,
      };
      const sr = await fetch(`${apiBase}/googleAds:search`, {
        method: "POST", headers, body: JSON.stringify(searchBody),
      });
      const sj = await sr.json();
      const existing = sj?.results?.[0]?.campaignCriterion;

      let mutateBody: any;
      let mode: "remove" | "create_negative";

      if (existing?.resourceName) {
        // Remove o critério existente (positivo OU negativo já criado antes)
        mode = "remove";
        mutateBody = { operations: [{ remove: existing.resourceName }] };
      } else {
        // Cria como negativo
        mode = "create_negative";
        mutateBody = {
          operations: [{
            create: {
              campaign: campaignRN,
              negative: true,
              location: { geoTargetConstant: geoRN },
            },
          }],
        };
      }

      const r = await fetch(`${apiBase}/campaignCriteria:mutate`, {
        method: "POST", headers, body: JSON.stringify(mutateBody),
      });
      const j = await r.json();
      if (!r.ok) {
        console.error("[exclude_country]", mode, "google ads error", JSON.stringify(j));
        await logAction("failed", { meta: { mode }, body: mutateBody }, JSON.stringify(j));
        const detail =
          j?.error?.details?.[0]?.errors?.[0]?.message ??
          j?.error?.details?.[0]?.errors?.[0]?.errorCode ??
          j?.error?.message ??
          JSON.stringify(j);
        return json({ error: String(detail) });
      }
      await logAction("executed", { country_criterion_id: countryCriterionId, mode });
      return json({ ok: true, action, country_criterion_id: countryCriterionId, mode });
    }

    // set_ad_status: pausa/ativa um ou vários criativos (ad_group_ad)
    // body: { action: "set_ad_status", campaign_id, status: "PAUSED"|"ENABLED",
    //         ads: [{ ad_group_id, ad_id }, ...] }
    if (action === "set_ad_status") {
      if (!["ENABLED", "PAUSED"].includes(newStatus)) {
        return json({ error: "status deve ser ENABLED ou PAUSED" });
      }
      const ads = Array.isArray((body as any)?.ads) ? (body as any).ads : [];
      const cleaned = ads
        .map((a: any) => ({
          ad_group_id: String(a?.ad_group_id ?? "").replace(/\D/g, ""),
          ad_id: String(a?.ad_id ?? "").replace(/\D/g, ""),
        }))
        .filter((a: any) => a.ad_group_id && a.ad_id);
      if (cleaned.length === 0) return json({ error: "ads obrigatório" });

      const operations = cleaned.map((a: any) => ({
        update: {
          resourceName: `customers/${acc.customer_id}/adGroupAds/${a.ad_group_id}~${a.ad_id}`,
          status: newStatus,
        },
        updateMask: "status",
      }));

      const r = await fetch(`${apiBase}/adGroupAds:mutate`, {
        method: "POST", headers, body: JSON.stringify({ operations }),
      });
      const j = await r.json();
      if (!r.ok) {
        console.error("[set_ad_status] google ads error", JSON.stringify(j));
        await logAction("failed", { ads: cleaned, status: newStatus }, JSON.stringify(j));
        const detail =
          j?.error?.details?.[0]?.errors?.[0]?.message ??
          j?.error?.message ?? JSON.stringify(j);
        return json({ error: String(detail) });
      }
      // Atualiza ad_status localmente
      for (const a of cleaned) {
        await admin.from("creative_metrics")
          .update({ ad_status: newStatus })
          .eq("user_id", ownerId)
          .eq("campaign_id", camp.campaign_id)
          .eq("ad_group_id", a.ad_group_id)
          .eq("ad_id", a.ad_id);
      }
      await logAction("executed", { ads: cleaned, status: newStatus });
      return json({ ok: true, action, status: newStatus, count: cleaned.length });
    }

    // set_target_cpa: aplica TARGET_CPA na campanha + define target_cpa nos ad groups
    // body: { target_cpa_brl: number }  (BRL/USD: assumimos moeda da conta)
    if (action === "set_target_cpa") {
      const targetCpa = Number((body as any)?.target_cpa ?? 0);
      if (!Number.isFinite(targetCpa) || targetCpa <= 0) {
        return json({ error: "target_cpa inválido" });
      }
      const targetMicros = Math.max(10_000, Math.round((targetCpa * 1_000_000) / 10000) * 10000);

      // 1) Trocar bidding strategy da campanha para TARGET_CPA
      const stratBody = {
        operations: [{
          update: {
            resourceName: `customers/${acc.customer_id}/campaigns/${camp.campaign_id}`,
            targetCpa: { targetCpaMicros: String(targetMicros) },
          },
          updateMask: "target_cpa.target_cpa_micros",
        }],
      };
      const sR = await fetch(`${apiBase}/campaigns:mutate`, {
        method: "POST", headers, body: JSON.stringify(stratBody),
      });
      const sJ = await sR.json();
      if (!sR.ok) {
        await logAction("failed", stratBody, JSON.stringify(sJ));
        return json({ error: sJ?.error?.message ?? JSON.stringify(sJ) });
      }
      await logAction("executed", { target_cpa: targetCpa, target_micros: targetMicros });
      return json({ ok: true, action, target_cpa: targetCpa });
    }

    // set_budget_absolute: define o orçamento da campanha em valor absoluto (na moeda da conta)
    if (action === "set_budget_absolute") {
      const newBudget = Number((body as any)?.budget ?? 0);
      if (!Number.isFinite(newBudget) || newBudget <= 0) {
        return json({ error: "budget inválido" });
      }
      const query = `
        SELECT campaign.id, campaign.campaign_budget, campaign_budget.id, campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.id = ${camp.campaign_id}
      `;
      const sRes = await fetch(`${apiBase}/googleAds:search`, {
        method: "POST", headers, body: JSON.stringify({ query }),
      });
      const sJson = await sRes.json();
      if (!sRes.ok) {
        await logAction("failed", { query }, JSON.stringify(sJson));
        return json({ error: sJson?.error?.message ?? JSON.stringify(sJson) });
      }
      const row = (sJson.results ?? [])[0] as { campaignBudget?: { id?: string; amountMicros?: string } } | undefined;
      const budgetId = row?.campaignBudget?.id;
      if (!budgetId) {
        await logAction("skipped", { reason: "Sem budget vinculado" });
        return json({ error: "Campanha sem orçamento configurado" });
      }
      const nextMicros = Math.max(10_000, Math.round((newBudget * 1_000_000) / 10000) * 10000);
      const mutateBody = {
        operations: [{
          update: {
            resourceName: `customers/${acc.customer_id}/campaignBudgets/${budgetId}`,
            amountMicros: String(nextMicros),
          },
          updateMask: "amount_micros",
        }],
      };
      const r = await fetch(`${apiBase}/campaignBudgets:mutate`, {
        method: "POST", headers, body: JSON.stringify(mutateBody),
      });
      const j = await r.json();
      if (!r.ok) {
        await logAction("failed", { meta: { budgetId, nextMicros }, body: mutateBody }, JSON.stringify(j));
        return json({ error: j?.error?.message ?? JSON.stringify(j) });
      }
      await admin.from("campaigns").update({ budget_micros: nextMicros }).eq("id", camp.id);
      await logAction("executed", { budget_id: budgetId, to: nextMicros });
      return json({ ok: true, action, budget: newBudget });
    }

    // set_ad_group_cpa_absolute: define target_cpa_micros em valor absoluto em TODOS os ad groups da campanha
    // body: { target_cpa: number, ad_group_id?: string }
    if (action === "set_ad_group_cpa_absolute") {
      const targetCpa = Number((body as any)?.target_cpa ?? 0);
      const onlyAdGroupId = String((body as any)?.ad_group_id ?? "").replace(/\D/g, "");
      if (!Number.isFinite(targetCpa) || targetCpa <= 0) {
        return json({ error: "target_cpa inválido" });
      }
      const targetMicros = Math.max(10_000, Math.round((targetCpa * 1_000_000) / 10000) * 10000);
      const query = `
        SELECT ad_group.id, ad_group.name, ad_group.target_cpa_micros, ad_group.status
        FROM ad_group
        WHERE ad_group.campaign = 'customers/${acc.customer_id}/campaigns/${camp.campaign_id}'
          AND ad_group.status != 'REMOVED'
          ${onlyAdGroupId ? `AND ad_group.id = ${onlyAdGroupId}` : ""}
      `;
      const sRes = await fetch(`${apiBase}/googleAds:search`, {
        method: "POST", headers, body: JSON.stringify({ query }),
      });
      const sJson = await sRes.json();
      if (!sRes.ok) {
        await logAction("failed", { query }, JSON.stringify(sJson));
        return json({ error: sJson?.error?.message ?? JSON.stringify(sJson) });
      }
      const rows = (sJson.results ?? []) as Array<{
        adGroup: { id: string; name: string; targetCpaMicros?: string };
      }>;
      if (rows.length === 0) {
        await logAction("skipped", { reason: "Nenhum ad_group encontrado" });
        return json({ error: "Nenhum ad group encontrado para essa campanha." });
      }
      const ops = rows.map((r) => ({
        update: {
          resourceName: `customers/${acc.customer_id}/adGroups/${r.adGroup.id}`,
          targetCpaMicros: String(targetMicros),
        },
        updateMask: "target_cpa_micros",
        _meta: { ad_group_id: r.adGroup.id, name: r.adGroup.name, from: Number(r.adGroup.targetCpaMicros ?? 0), to: targetMicros },
      }));
      const mutateBody = { operations: ops.map(({ _meta, ...o }) => o) };
      const meta = ops.map((o) => o._meta);
      const r = await fetch(`${apiBase}/adGroups:mutate`, {
        method: "POST", headers, body: JSON.stringify(mutateBody),
      });
      const j = await r.json();
      if (!r.ok) {
        await logAction("failed", { meta, body: mutateBody }, JSON.stringify(j));
        return json({ error: j?.error?.message ?? JSON.stringify(j) });
      }
      await logAction("executed", { target_cpa: targetCpa, ad_groups: meta });
      return json({ ok: true, action, target_cpa: targetCpa, ad_groups_updated: meta.length, details: meta });
    }

    return json({ error: "unreachable" });
  } catch (e) {
    console.error("[google-ads-mutate] uncaught", e);
    return json({ error: String(e) });
  }
});

async function resolveCampaignSiteId(admin: any, userId: string, campaignId: string, accountId: string): Promise<string | null> {
  // 1) Tenta pelo histórico de receita do GAM (mais preciso)
  const { data: revenueSites } = await admin
    .from("gam_placement_revenue")
    .select("site_id, revenue_usd")
    .eq("user_id", userId)
    .eq("campaign_id", campaignId)
    .not("site_id", "is", null)
    .limit(1000);

  const bySite = new Map<string, number>();
  for (const row of revenueSites ?? []) {
    const sid = String(row.site_id ?? "");
    if (!sid) continue;
    bySite.set(sid, (bySite.get(sid) ?? 0) + (Number(row.revenue_usd) || 0));
  }
  if (bySite.size === 1) return [...bySite.keys()][0];
  if (bySite.size > 1) return [...bySite.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // 2) Fallback: campanhas novas sem receita ainda — usa o vínculo conta↔site
  // Só é seguro se a conta estiver vinculada a EXATAMENTE 1 site.
  if (accountId) {
    const { data: links } = await admin
      .from("account_site_links")
      .select("site_id")
      .eq("user_id", userId)
      .eq("google_account_id", accountId);
    const unique = Array.from(new Set((links ?? []).map((l: any) => String(l.site_id)).filter(Boolean)));
    if (unique.length === 1) return unique[0];
  }

  return null;
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
