// Limpeza global de PAÍSES ruins por campanha.
// Reaproveita campaign_country_metrics + daily_metrics (mesma lógica da aba Países).
// Modos: preview | apply | notify
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { getRevSharePct } from "../_shared/revshare.ts";
import { computeCountryPerformance } from "../_shared/country_performance.ts";

interface ApplyItem {
  campaign_id: string;
  google_account_id?: string | null;
  country_code: string;
  country_name?: string | null;
  country_criterion_id: string;
  cost_brl?: number;
  revenue_brl?: number;
  roi_pct?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const isService = authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "___");
    const body = await req.json().catch(() => ({}));
    const mode: "preview" | "apply" | "notify" = body?.mode ?? "preview";
    const minCostBrl = Math.max(0, Number(body?.min_cost_brl ?? 50));
    const maxRoiPct = Number(body?.max_roi_pct ?? -10);
    const minCountries = Math.max(1, Number(body?.min_countries ?? 3));
    const minCampaignCostBrl = Math.max(0, Number(body?.min_campaign_cost_brl ?? 400));
    const fxUsdBrl = Number(body?.fx_usd_brl ?? 5);
    const lookbackDays = Math.max(1, Number(body?.lookback_days ?? 15));
    const recentChangeDays = Math.max(0, Number(body?.recent_change_days ?? 7));
    const minCampaignAgeDays = Math.max(0, Number(body?.min_campaign_age_days ?? 10));
    const targetUserId: string | undefined = body?.user_id;
    const siteId: string | null =
      typeof body?.site_id === "string" && body.site_id && body.site_id !== "all" ? body.site_id : null;
    const accountIds: string[] = Array.isArray(body?.google_account_ids)
      ? body.google_account_ids.map((x: unknown) => String(x)).filter(Boolean)
      : [];

    const isCron = isService && !!targetUserId;
    if (!isCron && !siteId) {
      return json({ error: "Site obrigatório: selecione um site antes de rodar a limpeza de países." });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let userId: string | null = null;
    if (isService && targetUserId) {
      userId = targetUserId;
    } else {
      if (!authHeader.startsWith("Bearer ")) return json({ error: "Login obrigatório" });
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
      );
      const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
      userId = claims?.claims?.sub ?? null;
      if (!userId) return json({ error: "Token inválido" });
    }
    if (!userId) return json({ error: "Token inválido" });

    const REV_SHARE_PCT = (await getRevSharePct(admin, userId, siteId)) / 100;
    const NET_FACTOR = 1 - REV_SHARE_PCT;
    console.log(`[geo-cleanup] revshare=${(REV_SHARE_PCT * 100).toFixed(2)}% · net_factor=${NET_FACTOR.toFixed(4)}`);

    const today = new Date();
    const toDate = new Date(today.getTime() - 86400_000);
    const fromDate = new Date(today.getTime() - lookbackDays * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const from = iso(fromDate);
    const to = iso(toDate);

    // Restringe contas Ads ao site selecionado
    let allowedAccountIds: string[] | null = null;
    if (siteId) {
      const { data: links, error: linkErr } = await admin
        .from("account_site_links")
        .select("google_account_id")
        .eq("user_id", userId)
        .eq("site_id", siteId);
      if (linkErr) return json({ error: linkErr.message });
      allowedAccountIds = [...new Set((links ?? []).map((l) => String(l.google_account_id)))];
      if (accountIds.length > 0) allowedAccountIds = allowedAccountIds.filter((id) => accountIds.includes(id));
      if (allowedAccountIds.length === 0) {
        return json({ ok: true, items: [], stats: { period: { from, to } }, info: "Nenhuma conta Ads vinculada ao site." });
      }
    } else if (accountIds.length > 0) {
      allowedAccountIds = accountIds;
    }

    // Campanhas e seus lifecycles (para excluir 'testing')
    let campsQuery = admin
      .from("campaigns")
      .select("campaign_id, name, status, google_account_id")
      .eq("user_id", userId)
      .eq("status", "enabled");
    if (allowedAccountIds) campsQuery = campsQuery.in("google_account_id", allowedAccountIds);
    const { data: camps, error: cErr } = await campsQuery;
    if (cErr) return json({ error: cErr.message });

    const campMap = new Map<string, { name: string; google_account_id: string }>();
    for (const c of camps ?? []) {
      if (c.google_account_id) campMap.set(String(c.campaign_id), { name: c.name, google_account_id: c.google_account_id });
    }
    const campIds = [...campMap.keys()];
    if (campIds.length === 0) return json({ ok: true, items: [], stats: { period: { from, to } } });

    // Lifecycle: ignorar 'testing'
    const testingIds = new Set<string>();
    for (const chunk of chunkArr(campIds, 200)) {
      const { data } = await admin
        .from("campaign_automation")
        .select("campaign_id, lifecycle_status")
        .eq("user_id", userId)
        .in("campaign_id", chunk);
      for (const r of data ?? []) {
        if (String(r.lifecycle_status ?? "").toLowerCase() === "testing") testingIds.add(String(r.campaign_id));
      }
    }

    // Campanhas com mudança recente de países (últimos N dias) → ignorar
    const recentlyChangedIds = new Set<string>();
    if (recentChangeDays > 0) {
      const sinceIso = new Date(Date.now() - recentChangeDays * 86400_000).toISOString();
      for (const chunk of chunkArr(campIds, 200)) {
        const { data } = await admin
          .from("geo_cleanup_logs")
          .select("campaign_id, executed_at")
          .eq("user_id", userId)
          .in("campaign_id", chunk)
          .gte("executed_at", sinceIso);
        for (const r of data ?? []) recentlyChangedIds.add(String(r.campaign_id));
      }
    }

    // Idade da campanha: primeiro dia com dados em daily_metrics
    const campFirstSeen = new Map<string, string>();
    if (minCampaignAgeDays > 0) {
      for (const chunk of chunkArr(campIds, 200)) {
        const { data } = await admin
          .from("daily_metrics")
          .select("campaign_id, date")
          .eq("user_id", userId)
          .in("campaign_id", chunk)
          .order("date", { ascending: true })
          .limit(50000);
        for (const r of data ?? []) {
          const id = String(r.campaign_id);
          const d = String(r.date);
          const prev = campFirstSeen.get(id);
          if (!prev || d < prev) campFirstSeen.set(id, d);
        }
      }
    }
    const ageCutoffIso = new Date(Date.now() - minCampaignAgeDays * 86400_000).toISOString().slice(0, 10);
    // === Engine compartilhada: cálculo oficial de custo/receita por país ===
    const engineResult = await computeCountryPerformance({
      admin, userId: userId!, siteId,
      accountIds: allowedAccountIds,
      campaignIds: campIds,
      from, to, fxUsdBrl, netFactor: NET_FACTOR,
    });
    const cells = engineResult.cells;
    // Adapter: campAgg compatível com o restante do código
    const campAgg = new Map<string, { cost: number; revenue: number; countries: Set<string> }>();
    for (const [cid, t] of engineResult.campaignTotals) {
      campAgg.set(cid, { cost: t.cost_brl, revenue: t.revenue_brl_net, countries: new Set(t.countries) });
    }

    // ✅ Conta REAL de países segmentados na campanha (Google Ads campaign_criterion LOCATION positivos)
    // Métricas (impressões) podem mostrar países não segmentados (VPN/viajantes), por isso usamos a config real.
    const realTargetCount = new Map<string, number>(); // campaign_id → nº de locations positivas
    const campsByAccount = new Map<string, string[]>();
    for (const [cid, meta] of campMap.entries()) {
      const arr = campsByAccount.get(meta.google_account_id) ?? [];
      arr.push(cid);
      campsByAccount.set(meta.google_account_id, arr);
    }
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const devToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!;
    for (const [accountId, ids] of campsByAccount.entries()) {
      try {
        const { data: acc } = await admin
          .from("google_accounts")
          .select("customer_id, refresh_token, login_customer_id")
          .eq("id", accountId)
          .maybeSingle();
        if (!acc?.refresh_token) continue;
        const tokRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId, client_secret: clientSecret,
            refresh_token: acc.refresh_token, grant_type: "refresh_token",
          }),
        });
        const tokJson = await tokRes.json();
        if (!tokRes.ok) continue;
        const accessToken = tokJson.access_token as string;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devToken,
          "Content-Type": "application/json",
        };
        if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;
        for (const chunk of chunkArr(ids, 100)) {
          const inList = chunk.map((x) => `'${x}'`).join(",");
          const query = `
            SELECT campaign.id, campaign_criterion.location.geo_target_constant, campaign_criterion.criterion_id
            FROM campaign_criterion
            WHERE campaign_criterion.type = LOCATION
              AND campaign_criterion.negative = FALSE
              AND campaign_criterion.status = ENABLED
              AND campaign.id IN (${inList})
          `;
          const r = await fetch(`https://googleads.googleapis.com/v21/customers/${acc.customer_id}/googleAds:search`, {
            method: "POST", headers, body: JSON.stringify({ query, pageSize: 10000 }),
          });
          const j = await r.json();
          if (!r.ok) { console.error("[geo-cleanup target query]", JSON.stringify(j)); continue; }
          const seen = new Map<string, Set<string>>();
          for (const row of (j.results ?? []) as any[]) {
            const cid = String(row.campaign?.id ?? "");
            const geo = String(row.campaignCriterion?.location?.geoTargetConstant ?? row.campaignCriterion?.criterionId ?? "");
            if (!cid || !geo) continue;
            const s = seen.get(cid) ?? new Set<string>();
            s.add(geo);
            seen.set(cid, s);
          }
          for (const [cid, s] of seen.entries()) realTargetCount.set(cid, s.size);
          // campanhas sem nenhum critério LOCATION positivo = sem segmentação geográfica explícita (mundo inteiro)
        }
      } catch (e) {
        console.error("[geo-cleanup target fetch]", e);
      }
    }


    // Decisão por país
    type Status = "ok" | "monitor" | "remove";
    interface Item {
      campaign_id: string;
      google_account_id: string | null;
      country_code: string;
      country_name: string;
      country_criterion_id: string | null;
      cost_brl: number;
      revenue_brl: number;
      clicks: number;
      impressions: number;
      profit_brl: number;
      roi_pct: number;
      status: Status;
      reason: string;
      campaign_name: string;
      campaign_cost_brl: number;
      countries_in_campaign: number;
      protected: boolean;
    }
    const items: Item[] = [];
    let skippedTesting = 0;
    let skippedFewCountries = 0;
    let skippedLowCampCost = 0;
    let skippedLowCountryCost = 0;
    let skippedRecentChange = 0;
    let skippedTooNew = 0;

    for (const c of cells.values()) {
      const meta = campMap.get(c.campaign_id);
      if (!meta) continue;
      const camp = campAgg.get(c.campaign_id)!;
      const profit = c.revenue_brl - c.cost_brl;
      const roi = c.cost_brl > 0 ? (profit / c.cost_brl) * 100 : 0;

      let status: Status = "ok";
      let reason = "ok";
      let isProtected = false;

      if (testingIds.has(c.campaign_id)) {
        skippedTesting++;
        continue;
      } else if (recentlyChangedIds.has(c.campaign_id)) {
        skippedRecentChange++;
        continue;
      } else if (minCampaignAgeDays > 0 && (campFirstSeen.get(c.campaign_id) ?? "9999") > ageCutoffIso) {
        skippedTooNew++;
        continue;
      } else if ((realTargetCount.get(c.campaign_id) ?? camp.countries.size) < minCountries) {
        skippedFewCountries++;
        continue;
      } else if (camp.cost < minCampaignCostBrl) {
        skippedLowCampCost++;
        continue;
      } else if (c.cost_brl < minCostBrl) {
        skippedLowCountryCost++;
        reason = `país com custo < R$ ${minCostBrl}`;
        status = roi <= maxRoiPct ? "monitor" : "ok";
      } else if (roi <= maxRoiPct) {
        status = "remove";
        reason = `ROI ${roi.toFixed(1)}% ≤ ${maxRoiPct}%`;
      } else if (roi <= 0) {
        status = "monitor";
        reason = "ROI negativo mas acima do corte";
      } else {
        status = "ok";
        reason = "lucrativo";
      }

      items.push({
        ...c,
        profit_brl: round(profit),
        roi_pct: round(roi),
        cost_brl: round(c.cost_brl),
        revenue_brl: round(c.revenue_brl),
        status,
        reason,
        campaign_name: meta.name,
        campaign_cost_brl: round(camp.cost),
        countries_in_campaign: realTargetCount.get(c.campaign_id) ?? camp.countries.size,
        protected: isProtected,
      });
    }

    items.sort((a, b) => {
      const order = { remove: 0, monitor: 1, ok: 2 } as Record<Status, number>;
      return order[a.status] - order[b.status] || a.roi_pct - b.roi_pct;
    });

    const stats = {
      total_cells: cells.size,
      campaigns: campAgg.size,
      to_remove: items.filter((i) => i.status === "remove").length,
      monitor: items.filter((i) => i.status === "monitor").length,
      ok: items.filter((i) => i.status === "ok").length,
      skipped_testing: skippedTesting,
      skipped_few_countries: skippedFewCountries,
      skipped_low_camp_cost: skippedLowCampCost,
      skipped_low_country_cost: skippedLowCountryCost,
      skipped_recent_change: skippedRecentChange,
      skipped_too_new: skippedTooNew,
      period: { from, to },
      thresholds: { max_roi_pct: maxRoiPct, min_cost_brl: minCostBrl, min_countries: minCountries, min_campaign_cost_brl: minCampaignCostBrl, recent_change_days: recentChangeDays, min_campaign_age_days: minCampaignAgeDays },
    };

    if (mode === "preview") return json({ ok: true, items, stats });

    if (mode === "notify") {
      const removeItems = items.filter((i) => i.status === "remove");
      if (removeItems.length > 0) {
        await admin.from("alerts").insert({
          user_id: userId,
          severity: "warning",
          category: "geo_cleanup",
          title: `${removeItems.length} país(es) ruins detectados`,
          message: `Auto-revisão de países: ${removeItems.length} candidatos a remoção.`,
          metric_snapshot: { items: removeItems.slice(0, 100), stats },
        });
        // Log como sugestão
        const logs = removeItems.slice(0, 500).map((i) => ({
          user_id: userId,
          site_id: siteId,
          google_account_id: i.google_account_id,
          campaign_id: i.campaign_id,
          campaign_name: i.campaign_name,
          country_code: i.country_code,
          country_name: i.country_name,
          country_criterion_id: i.country_criterion_id,
          roi_pct: i.roi_pct,
          cost_brl: i.cost_brl,
          revenue_brl: i.revenue_brl,
          action: "suggested",
          lookback_days: lookbackDays,
        }));
        if (logs.length) await admin.from("geo_cleanup_logs").insert(logs);
      }
      await admin.from("rules_config").update({ geo_cleanup_last_run_at: new Date().toISOString() }).eq("user_id", userId);
      return json({ ok: true, items, stats, notified: removeItems.length });
    }

    if (mode === "apply") {
      const selected: ApplyItem[] = Array.isArray(body?.items) && body.items.length
        ? body.items as ApplyItem[]
        : items.filter((i) => i.status === "remove" && i.country_criterion_id).map((i) => ({
            campaign_id: i.campaign_id,
            google_account_id: i.google_account_id,
            country_code: i.country_code,
            country_name: i.country_name,
            country_criterion_id: i.country_criterion_id!,
            cost_brl: i.cost_brl,
            revenue_brl: i.revenue_brl,
            roi_pct: i.roi_pct,
          }));

      let applied = 0;
      let failed = 0;
      const details: any[] = [];
      const logs: any[] = [];

      for (const it of selected) {
        if (!it.country_criterion_id) { failed++; details.push({ ...it, error: "sem country_criterion_id" }); continue; }
        try {
          const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/google-ads-mutate`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "x-system-user-id": userId!,
            },
            body: JSON.stringify({
              user_id: userId,
              action: "exclude_country",
              campaign_id: it.campaign_id,
              country_criterion_id: it.country_criterion_id,
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok && !j?.error) {
            applied++;
            details.push({ ...it, ok: true });
            logs.push({
              user_id: userId,
              site_id: siteId,
              google_account_id: it.google_account_id,
              campaign_id: it.campaign_id,
              campaign_name: campMap.get(it.campaign_id)?.name ?? null,
              country_code: it.country_code,
              country_name: it.country_name,
              country_criterion_id: it.country_criterion_id,
              roi_pct: it.roi_pct,
              cost_brl: it.cost_brl,
              revenue_brl: it.revenue_brl,
              action: "removed",
              lookback_days: lookbackDays,
            });
          } else {
            failed++;
            details.push({ ...it, error: j?.error ?? `http ${r.status}` });
          }
        } catch (e) {
          failed++;
          details.push({ ...it, error: String(e instanceof Error ? e.message : e) });
        }
      }

      if (logs.length) await admin.from("geo_cleanup_logs").insert(logs);
      await admin.from("rules_config").update({ geo_cleanup_last_run_at: new Date().toISOString() }).eq("user_id", userId);

      return json({ ok: true, applied, failed, details, stats });
    }

    return json({ error: "mode inválido" });
  } catch (e) {
    console.error("[geo-cleanup]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});

function chunkArr<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function round(n: number) { return Math.round(n * 100) / 100; }
function json(p: unknown) {
  return new Response(JSON.stringify(p), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
