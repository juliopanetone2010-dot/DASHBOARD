// Mutações em Google Ads:
// - set_status: pausar / ativar campanha
// - adjust_cpa: ajusta target_cpa_micros de todos os ad groups da campanha por % (delta)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

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

    if (!campaignId) return json({ error: "campaign_id obrigatório" });
    if (!["set_status", "adjust_cpa", "apply_utm", "adjust_budget", "exclude_country"].includes(action)) {
      return json({ error: "action inválida" });
    }

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Localiza campanha + conta Ads
    const { data: camp, error: cErr } = await admin
      .from("campaigns")
      .select("id, campaign_id, name, status, google_account_id")
      .eq("user_id", userId)
      .eq("campaign_id", campaignId)
      .maybeSingle();
    if (cErr || !camp) return json({ error: "Campanha não encontrada" });
    if (!camp.google_account_id) return json({ error: "Campanha sem conta Ads vinculada" });

    const { data: acc, error: aErr } = await admin
      .from("google_accounts")
      .select("customer_id, refresh_token, login_customer_id")
      .eq("id", camp.google_account_id)
      .maybeSingle();
    if (aErr || !acc?.refresh_token) return json({ error: "Conta Ads sem refresh token" });

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

    const apiBase = `https://googleads.googleapis.com/v21/customers/${acc.customer_id}`;

    // Log da ação
    const logAction = async (status: string, payload: unknown, error?: string) => {
      await admin.from("automation_actions").insert({
        user_id: userId,
        campaign_id: camp.campaign_id,
        action_type: action,
        payload: payload as any,
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
          const next = Math.max(1, Math.round(current * (1 + deltaPct / 100)));
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
      const nextMicros = Math.max(10_000, Math.round(currentMicros * (1 + deltaPct / 100)));
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

    // exclude_country: adiciona um campaign_criterion negativo de location (geoTargetConstant)
    if (action === "exclude_country") {
      const countryCriterionId = String((body as any)?.country_criterion_id ?? "").replace(/\D/g, "");
      if (!countryCriterionId) return json({ error: "country_criterion_id obrigatório" });

      const mutateBody = {
        operations: [{
          create: {
            campaign: `customers/${acc.customer_id}/campaigns/${camp.campaign_id}`,
            negative: true,
            location: { geoTargetConstant: `geoTargetConstants/${countryCriterionId}` },
          },
        }],
      };
      const r = await fetch(`${apiBase}/campaignCriteria:mutate`, {
        method: "POST", headers, body: JSON.stringify(mutateBody),
      });
      const j = await r.json();
      if (!r.ok) {
        await logAction("failed", mutateBody, JSON.stringify(j));
        return json({ error: j?.error?.message ?? JSON.stringify(j) });
      }
      await logAction("executed", { country_criterion_id: countryCriterionId });
      return json({ ok: true, action, country_criterion_id: countryCriterionId });
    }

    return json({ error: "unreachable" });
  } catch (e) {
    console.error("[google-ads-mutate] uncaught", e);
    return json({ error: String(e) });
  }
});

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
