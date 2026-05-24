// Reverte ações de automação executadas (Google Ads + banco).
// Lê automation_actions executed dentro de uma janela e:
//  - adjust_budget: restaura amountMicros para o valor "from"
//  - adjust_cpa: restaura targetCpaMicros de cada ad_group para o valor "from"
//  - negative_placement: remove o campaign_criterion negativo correspondente
// Também:
//  - apaga placement_actions(blacklist) inseridos pela esteira no período
//  - apaga placement_cleanup_logs e automation_logs do período
//  - reseta campaign_automation.lifecycle / last_action quando aplicável
//
// Body: { site_ids?: string[], hours?: number, dry_run?: boolean }
// Defaults: hours=6, dry_run=false. Sempre escopado ao usuário autenticado.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Login obrigatório" }, 401);

    const body = await req.json().catch(() => ({}));
    const hours = Math.max(1, Math.min(72, Number(body?.hours ?? 6)));
    const dryRun = Boolean(body?.dry_run ?? false);
    const siteIds: string[] | null = Array.isArray(body?.site_ids) && body.site_ids.length
      ? body.site_ids.map((x: unknown) => String(x)) : null;

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub as string | undefined;
    if (!userId) return json({ error: "Token inválido" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: hasPerm } = await admin.rpc("admin_has_permission", { _uid: userId, _perm: "can_run_automation" });
    if (!hasPerm) return json({ error: "Permissão negada: can_run_automation" }, 403);


    const since = new Date(Date.now() - hours * 3600_000).toISOString();

    // 1. Carrega automation_actions executed do período
    let aaQ = admin
      .from("automation_actions")
      .select("id, action_type, campaign_id, payload, created_at, status")
      .eq("user_id", userId)
      .eq("status", "executed")
      .gte("created_at", since)
      .in("action_type", ["adjust_budget", "adjust_cpa", "negative_placement"])
      .order("created_at", { ascending: false });
    const { data: actions, error: aaErr } = await aaQ;
    if (aaErr) return json({ error: aaErr.message }, 500);

    // Resolve google_account_id e site_id por campaign_id quando faltarem no payload.
    const allCampIds = [...new Set((actions ?? []).map((a: any) => String(a.campaign_id)))];
    const { data: campRows } = await admin
      .from("campaigns").select("campaign_id, google_account_id")
      .eq("user_id", userId).in("campaign_id", allCampIds.length ? allCampIds : ["__none__"]);
    const campToAccount = new Map<string, string>();
    for (const c of campRows ?? []) if (c.google_account_id) campToAccount.set(String(c.campaign_id), String(c.google_account_id));

    const { data: linkRows } = await admin
      .from("account_site_links").select("google_account_id, site_id").eq("user_id", userId);
    const accountToSites = new Map<string, string[]>();
    for (const l of linkRows ?? []) {
      const k = String(l.google_account_id);
      const arr = accountToSites.get(k) ?? [];
      arr.push(String(l.site_id));
      accountToSites.set(k, arr);
    }

    // Enriquecer payload com site_id/google_account_id resolvidos
    for (const a of (actions ?? []) as any[]) {
      a.payload = a.payload ?? {};
      if (!a.payload.google_account_id) {
        const gaid = campToAccount.get(String(a.campaign_id));
        if (gaid) a.payload.google_account_id = gaid;
      }
      if (!a.payload.site_id && a.payload.google_account_id) {
        const sites = accountToSites.get(String(a.payload.google_account_id)) ?? [];
        if (sites.length === 1) a.payload.site_id = sites[0];
      }
    }

    // Filtra por site_ids (payload.site_id)
    const filtered = (actions ?? []).filter((a: any) => {
      if (!siteIds) return true;
      const sid = a?.payload?.site_id ? String(a.payload.site_id) : null;
      return sid && siteIds.includes(sid);
    });

    // Mapa de contas (refresh tokens)
    const accountIds = [...new Set(filtered.map((a: any) =>
      a?.payload?.google_account_id ? String(a.payload.google_account_id) : null
    ).filter(Boolean))] as string[];
    const { data: accs } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id")
      .in("id", accountIds.length ? accountIds : ["__none__"]);
    const accMap = new Map<string, any>();
    for (const a of accs ?? []) accMap.set(a.id, a);

    const tokenCache = new Map<string, string>();
    const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;
    const summary: any[] = [];
    let reverted = 0, failed = 0, skipped = 0;

    for (const act of filtered) {
      const p: any = act.payload ?? {};
      const acc = accMap.get(String(p.google_account_id));
      if (!acc?.refresh_token) { skipped++; summary.push({ id: act.id, status: "skip_no_account" }); continue; }

      try {
        const accessToken = await getToken(acc.refresh_token, tokenCache);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devToken,
          "Content-Type": "application/json",
        };
        if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;
        const apiBase = `https://googleads.googleapis.com/v21/customers/${acc.customer_id}`;

        if (act.action_type === "adjust_budget") {
          const budgetId = p.budget_id;
          const fromMicros = Number(p.from);
          if (!budgetId || !Number.isFinite(fromMicros) || fromMicros <= 0) { skipped++; summary.push({ id: act.id, status: "skip_bad_payload" }); continue; }
          if (dryRun) { summary.push({ id: act.id, status: "would_revert", action: "adjust_budget", to: fromMicros }); continue; }
          const r = await fetch(`${apiBase}/campaignBudgets:mutate`, {
            method: "POST", headers,
            body: JSON.stringify({ operations: [{
              update: { resourceName: `customers/${acc.customer_id}/campaignBudgets/${budgetId}`, amountMicros: String(fromMicros) },
              updateMask: "amount_micros",
            }] }),
          });
          const j = await r.json();
          if (!r.ok) { failed++; summary.push({ id: act.id, status: "fail", error: j?.error?.message ?? JSON.stringify(j) }); continue; }
          await admin.from("campaigns").update({ budget_micros: fromMicros })
            .eq("user_id", userId).eq("campaign_id", act.campaign_id);
          reverted++;
          summary.push({ id: act.id, status: "reverted", action: "adjust_budget", campaign_id: act.campaign_id, to: fromMicros });
        }
        else if (act.action_type === "adjust_cpa") {
          const ops = (p.ad_groups ?? []).map((g: any) => ({
            update: {
              resourceName: `customers/${acc.customer_id}/adGroups/${g.ad_group_id}`,
              targetCpaMicros: String(Math.max(10000, Math.round(Number(g.from) / 10000) * 10000)),
            },
            updateMask: "target_cpa_micros",
          }));
          if (!ops.length) { skipped++; summary.push({ id: act.id, status: "skip_no_groups" }); continue; }
          if (dryRun) { summary.push({ id: act.id, status: "would_revert", action: "adjust_cpa", groups: ops.length }); continue; }
          const r = await fetch(`${apiBase}/adGroups:mutate`, {
            method: "POST", headers, body: JSON.stringify({ operations: ops }),
          });
          const j = await r.json();
          if (!r.ok) { failed++; summary.push({ id: act.id, status: "fail", error: j?.error?.message ?? JSON.stringify(j) }); continue; }
          reverted++;
          summary.push({ id: act.id, status: "reverted", action: "adjust_cpa", campaign_id: act.campaign_id, groups: ops.length });
        }
        else if (act.action_type === "negative_placement") {
          // Lista os negative campaign criteria atuais e remove os que batem com nossos placements.
          const placements: any[] = Array.isArray(p.placements) ? p.placements : [];
          const okList: string[] = Array.isArray(p.ok) ? p.ok : placements.map((x: any) => x.placement);
          if (!okList.length) { skipped++; summary.push({ id: act.id, status: "skip_no_placements" }); continue; }

          const query = `
            SELECT campaign_criterion.resource_name, campaign_criterion.placement.url,
                   campaign_criterion.mobile_application.app_id
            FROM campaign_criterion
            WHERE campaign_criterion.campaign = 'customers/${acc.customer_id}/campaigns/${act.campaign_id}'
              AND campaign_criterion.negative = TRUE
          `;
          const sRes = await fetch(`${apiBase}/googleAds:search`, {
            method: "POST", headers, body: JSON.stringify({ query }),
          });
          const sJson = await sRes.json();
          if (!sRes.ok) { failed++; summary.push({ id: act.id, status: "fail_search", error: JSON.stringify(sJson?.error ?? sJson).slice(0, 500) }); continue; }
          const rows = (sJson.results ?? []) as any[];

          const wantedHosts = new Set<string>();
          const wantedAppIds = new Set<string>();
          for (const pl of placements) {
            if (pl.type === "MOBILE_APPLICATION" && pl.app_id) wantedAppIds.add(String(pl.app_id));
            else wantedHosts.add(hostOf(String(pl.placement)));
          }
          for (const o of okList) wantedHosts.add(hostOf(String(o)));

          const removeOps: any[] = [];
          const matched: string[] = [];
          for (const row of rows) {
            const cc = row.campaignCriterion ?? {};
            const rn = cc.resourceName;
            if (!rn) continue;
            if (cc.placement?.url && wantedHosts.has(hostOf(String(cc.placement.url)))) {
              removeOps.push({ remove: rn });
              matched.push(cc.placement.url);
            } else if (cc.mobileApplication?.appId && wantedAppIds.has(String(cc.mobileApplication.appId))) {
              removeOps.push({ remove: rn });
              matched.push(cc.mobileApplication.appId);
            }
          }
          if (!removeOps.length) { skipped++; summary.push({ id: act.id, status: "skip_already_clean", campaign_id: act.campaign_id }); continue; }
          if (dryRun) { summary.push({ id: act.id, status: "would_revert", action: "negative_placement", remove: removeOps.length, matched }); continue; }

          const r = await fetch(`${apiBase}/campaignCriteria:mutate`, {
            method: "POST", headers,
            body: JSON.stringify({ operations: removeOps, partialFailure: true }),
          });
          const j = await r.json();
          if (!r.ok) { failed++; summary.push({ id: act.id, status: "fail", error: j?.error?.message ?? JSON.stringify(j) }); continue; }

          // Limpa blacklist correspondente em placement_actions
          const hosts = [...wantedHosts];
          if (hosts.length) {
            await admin.from("placement_actions")
              .delete()
              .eq("user_id", userId)
              .eq("campaign_id", act.campaign_id)
              .eq("action", "blacklist")
              .in("placement", hosts);
          }
          reverted++;
          summary.push({ id: act.id, status: "reverted", action: "negative_placement", campaign_id: act.campaign_id, removed: removeOps.length });
        }

        if (!dryRun) {
          await admin.from("automation_actions").update({
            status: "reverted",
            error: `reverted at ${new Date().toISOString()}`,
          }).eq("id", act.id);
        }
      } catch (e) {
        failed++;
        summary.push({ id: act.id, status: "fail", error: String(e instanceof Error ? e.message : e) });
      }
    }

    // Limpeza de logs/banco do período (apenas para sites do escopo)
    let cleanup = { automation_logs: 0, placement_cleanup_logs: 0, lifecycle_resets: 0 };
    if (!dryRun) {
      const sitesFilter = siteIds && siteIds.length ? siteIds : null;

      // automation_logs
      let dl = admin.from("automation_logs").delete().eq("user_id", userId).gte("created_at", since);
      if (sitesFilter) dl = dl.in("site_id", sitesFilter);
      const { count: c1 } = await dl.select("*", { count: "exact", head: true });
      cleanup.automation_logs = c1 ?? 0;

      // placement_cleanup_logs
      let dc = admin.from("placement_cleanup_logs").delete().eq("user_id", userId).gte("executed_at", since);
      if (sitesFilter) dc = dc.in("site_id", sitesFilter);
      const { count: c2 } = await dc.select("*", { count: "exact", head: true });
      cleanup.placement_cleanup_logs = c2 ?? 0;

      // Reset campaign_automation lifecycle p/ campanhas tocadas
      const touchedCampaigns = [...new Set(filtered.map((a: any) => String(a.campaign_id)))];
      if (touchedCampaigns.length) {
        const { count: c3 } = await admin.from("campaign_automation")
          .update({
            lifecycle_status: "testing",
            last_action: null,
            last_action_date: null,
            last_scale_date: null,
            last_cpa_action: null,
            last_cpa_action_date: null,
            last_evaluated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
          .in("campaign_id", touchedCampaigns)
          .select("*", { count: "exact", head: true });
        cleanup.lifecycle_resets = c3 ?? 0;
      }
    }

    return json({
      ok: true,
      dry_run: dryRun,
      window_hours: hours,
      site_ids: siteIds,
      total_actions: filtered.length,
      reverted, failed, skipped,
      cleanup,
      details: summary,
    });
  } catch (e) {
    console.error("[automation-revert]", e);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

function hostOf(u: string): string {
  try {
    const s = u.startsWith("http") ? u : `https://${u}`;
    return new URL(s).hostname.replace(/^www\./, "").toLowerCase();
  } catch { return u.replace(/^https?:\/\//, "").replace(/^www\./, "").toLowerCase(); }
}

async function getToken(refreshToken: string, cache: Map<string, string>): Promise<string> {
  if (cache.has(refreshToken)) return cache.get(refreshToken)!;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`refresh failed: ${JSON.stringify(j)}`);
  cache.set(refreshToken, j.access_token);
  return j.access_token;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
