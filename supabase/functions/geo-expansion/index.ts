// Expansão por país vencedor: identifica winners e (opcional) duplica campanha
// no Google Ads, focada apenas no país vencedor, em modo PAUSED.
//
// Modos:
//  - preview : retorna lista de winners com base em campaign_country_metrics + daily_metrics
//  - apply   : duplica a campanha (cria budget + campaign + ad_groups + ads + location criterion)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { getRevSharePct } from "../_shared/revshare.ts";

interface ApplyItem {
  campaign_id: string;
  google_account_id: string;
  country_code: string;
  country_name?: string;
  country_criterion_id: string; // geoTargetConstants/XXXX numeric id
  roi_pct?: number;
  cost_brl?: number;
  revenue_brl?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const isService = authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "___");
    const body = await req.json().catch(() => ({}));

    const mode: "preview" | "apply" = body?.mode ?? "preview";
    const minRoi = Number(body?.min_roi_pct ?? 25);
    const minCampaignCost = Math.max(0, Number(body?.min_campaign_cost_brl ?? 500));
    const minCountryCost = Math.max(0, Number(body?.min_country_cost_brl ?? 100));
    const minCountries = Math.max(1, Number(body?.min_countries ?? 3));
    const lookbackDays = Math.max(1, Number(body?.lookback_days ?? 7));
    const budgetMultiplier = Math.max(0.05, Number(body?.budget_multiplier ?? 0.5));
    const fxUsdBrl = Number(body?.fx_usd_brl ?? 5);
    const targetUserId: string | undefined = body?.user_id;
    const siteId: string | null =
      typeof body?.site_id === "string" && body.site_id && body.site_id !== "all" ? body.site_id : null;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Auth
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
    }
    if (!userId) return json({ error: "Token inválido" });

    const REV_SHARE_PCT = (await getRevSharePct(admin, userId!, siteId)) / 100;
    const NET_FACTOR = 1 - REV_SHARE_PCT;
    console.log(`[geo-expansion] revshare=${(REV_SHARE_PCT * 100).toFixed(2)}% · net_factor=${NET_FACTOR.toFixed(4)}`);

    // ===== APPLY: duplica uma campanha específica =====
    if (mode === "apply") {
      const item = body?.item as ApplyItem | undefined;
      if (!item?.campaign_id || !item?.country_criterion_id || !item?.google_account_id) {
        return json({ error: "item inválido (campaign_id, google_account_id, country_criterion_id obrigatórios)" });
      }
      const result = await duplicateCampaign(admin, userId!, item, budgetMultiplier, siteId);
      return json(result);
    }

    // ===== PREVIEW: lista winners =====
    const today = new Date();
    const toDate = new Date(today.getTime() - 86400_000);
    const fromDate = new Date(today.getTime() - lookbackDays * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const from = iso(fromDate);
    const to = iso(toDate);

    // Contas Ads do site
    let allowedAccountIds: string[] | null = null;
    if (siteId) {
      const { data: links } = await admin
        .from("account_site_links")
        .select("google_account_id")
        .eq("user_id", userId)
        .eq("site_id", siteId);
      allowedAccountIds = [...new Set((links ?? []).map((l) => String(l.google_account_id)))];
      if (allowedAccountIds.length === 0) {
        return json({ ok: true, items: [], stats: { period: { from, to } }, info: "Nenhuma conta Ads vinculada ao site." });
      }
    }

    // Campanhas enabled
    let campsQuery = admin
      .from("campaigns")
      .select("campaign_id, name, status, google_account_id, budget_micros")
      .eq("user_id", userId)
      .eq("status", "enabled");
    if (allowedAccountIds) campsQuery = campsQuery.in("google_account_id", allowedAccountIds);
    const { data: camps } = await campsQuery;
    const campMap = new Map<string, { name: string; google_account_id: string; budget_micros: number | null }>();
    for (const c of camps ?? []) {
      if (c.google_account_id) {
        campMap.set(String(c.campaign_id), {
          name: c.name,
          google_account_id: String(c.google_account_id),
          budget_micros: c.budget_micros ? Number(c.budget_micros) : null,
        });
      }
    }
    const campIds = [...campMap.keys()];
    if (campIds.length === 0) return json({ ok: true, items: [], stats: { period: { from, to } } });

    // Lifecycle (bloquear testing)
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

    // Já expandidas (evitar loop)
    const alreadyExpanded = new Set<string>(); // key: campaign_id|country_code
    {
      const { data } = await admin
        .from("campaign_expansion_logs")
        .select("original_campaign_id, country_code, action")
        .eq("user_id", userId)
        .in("action", ["created", "suggested"]);
      for (const r of data ?? []) {
        if (r.action === "created") alreadyExpanded.add(`${r.original_campaign_id}|${r.country_code}`);
      }
    }

    // País já tem campanha própria? heurística: nome da campanha contém " - XX WINNER" ou " - <Country>"
    // Pulamos isso por enquanto — o "loop guard" via logs já cobre.

    // Métricas por país
    type CountryRow = {
      campaign_id: string; date: string; country_code: string; country_name: string | null;
      country_criterion_id: string | null; google_account_id: string | null;
      cost: number; clicks: number; impressions: number; conversions: number;
    };
    const countryRows: CountryRow[] = [];
    for (const chunk of chunkArr(campIds, 200)) {
      let start = 0;
      for (;;) {
        const { data, error } = await admin
          .from("campaign_country_metrics")
          .select("campaign_id, date, country_code, country_name, country_criterion_id, google_account_id, cost, clicks, impressions, conversions")
          .eq("user_id", userId)
          .in("campaign_id", chunk)
          .gte("date", from)
          .lte("date", to)
          .range(start, start + 999);
        if (error) return json({ error: error.message });
        const rows = (data ?? []) as CountryRow[];
        countryRows.push(...rows);
        if (rows.length < 1000) break;
        start += 1000;
      }
    }

    // Receita por (camp, date)
    type DailyRow = { campaign_id: string; date: string; revenue: number };
    const dailyRows: DailyRow[] = [];
    for (const chunk of chunkArr(campIds, 200)) {
      const { data } = await admin
        .from("daily_metrics")
        .select("campaign_id, date, revenue")
        .eq("user_id", userId)
        .in("campaign_id", chunk)
        .gte("date", from)
        .lte("date", to)
        .limit(50000);
      for (const r of data ?? []) {
        dailyRows.push({ campaign_id: String(r.campaign_id), date: String(r.date), revenue: Number(r.revenue) || 0 });
      }
    }

    // Distribuição por impressões
    const imprByCD = new Map<string, number>();
    const clicksByCD = new Map<string, number>();
    const costByCD = new Map<string, number>();
    for (const r of countryRows) {
      const k = `${r.campaign_id}|${r.date}`;
      imprByCD.set(k, (imprByCD.get(k) ?? 0) + (r.impressions || 0));
      clicksByCD.set(k, (clicksByCD.get(k) ?? 0) + (r.clicks || 0));
      costByCD.set(k, (costByCD.get(k) ?? 0) + (r.cost || 0));
    }
    const revByCD = new Map<string, number>();
    for (const r of dailyRows) {
      const k = `${r.campaign_id}|${r.date}`;
      revByCD.set(k, (revByCD.get(k) ?? 0) + r.revenue);
    }

    interface Cell {
      campaign_id: string; country_code: string; country_name: string;
      country_criterion_id: string | null; google_account_id: string | null;
      cost_brl: number; revenue_brl: number; clicks: number; impressions: number;
    }
    const cells = new Map<string, Cell>();
    for (const r of countryRows) {
      const k = `${r.campaign_id}|${r.country_code}`;
      let c = cells.get(k);
      if (!c) {
        c = {
          campaign_id: r.campaign_id, country_code: r.country_code,
          country_name: r.country_name ?? r.country_code,
          country_criterion_id: r.country_criterion_id, google_account_id: r.google_account_id,
          cost_brl: 0, revenue_brl: 0, clicks: 0, impressions: 0,
        };
        cells.set(k, c);
      }
      c.cost_brl += r.cost || 0;
      c.clicks += r.clicks || 0;
      c.impressions += r.impressions || 0;
      if (!c.country_criterion_id && r.country_criterion_id) c.country_criterion_id = r.country_criterion_id;
      if (!c.google_account_id && r.google_account_id) c.google_account_id = r.google_account_id;

      const cd = `${r.campaign_id}|${r.date}`;
      const revUsd = revByCD.get(cd) || 0;
      if (revUsd > 0) {
        const totalImpr = imprByCD.get(cd) || 0;
        const totalClicks = clicksByCD.get(cd) || 0;
        const totalCost = costByCD.get(cd) || 0;
        let share = 0;
        if (totalImpr > 0) share = (r.impressions || 0) / totalImpr;
        else if (totalClicks > 0) share = (r.clicks || 0) / totalClicks;
        else if (totalCost > 0) share = (r.cost || 0) / totalCost;
        if (share > 0) c.revenue_brl += revUsd * share * NET_FACTOR * fxUsdBrl;
      }
    }

    // Agrega por campanha
    const campAgg = new Map<string, { cost: number; countries: Set<string> }>();
    for (const c of cells.values()) {
      let a = campAgg.get(c.campaign_id);
      if (!a) { a = { cost: 0, countries: new Set() }; campAgg.set(c.campaign_id, a); }
      a.cost += c.cost_brl;
      a.countries.add(c.country_code);
    }

    interface Winner {
      campaign_id: string; campaign_name: string; google_account_id: string;
      country_code: string; country_name: string; country_criterion_id: string | null;
      cost_brl: number; revenue_brl: number; roi_pct: number;
      campaign_cost_brl: number; countries_in_campaign: number;
      budget_micros: number | null;
    }
    const winners: Winner[] = [];
    for (const c of cells.values()) {
      const meta = campMap.get(c.campaign_id);
      if (!meta) continue;
      if (testingIds.has(c.campaign_id)) continue;
      const camp = campAgg.get(c.campaign_id)!;
      if (camp.countries.size < minCountries) continue;
      if (camp.cost < minCampaignCost) continue;
      if (c.cost_brl < minCountryCost) continue;
      if (alreadyExpanded.has(`${c.campaign_id}|${c.country_code}`)) continue;
      const profit = c.revenue_brl - c.cost_brl;
      const roi = c.cost_brl > 0 ? (profit / c.cost_brl) * 100 : 0;
      if (roi < minRoi) continue;
      winners.push({
        campaign_id: c.campaign_id,
        campaign_name: meta.name,
        google_account_id: meta.google_account_id,
        country_code: c.country_code,
        country_name: c.country_name,
        country_criterion_id: c.country_criterion_id,
        cost_brl: round(c.cost_brl),
        revenue_brl: round(c.revenue_brl),
        roi_pct: round(roi),
        campaign_cost_brl: round(camp.cost),
        countries_in_campaign: camp.countries.size,
        budget_micros: meta.budget_micros,
      });
    }
    winners.sort((a, b) => b.roi_pct - a.roi_pct);

    return json({ ok: true, items: winners, stats: { period: { from, to }, total: winners.length } });
  } catch (e) {
    console.error("[geo-expansion]", e);
    return json({ error: String(e) });
  }
});

// ===== Duplicate campaign =====
async function duplicateCampaign(
  admin: any, userId: string, item: ApplyItem, budgetMultiplier: number, siteId: string | null,
) {
  // Carrega conta
  const { data: acc } = await admin
    .from("google_accounts")
    .select("customer_id, refresh_token, login_customer_id")
    .eq("id", item.google_account_id)
    .maybeSingle();
  if (!acc?.refresh_token) return { error: "Conta Ads sem refresh token" };

  // Carrega campanha do banco (nome, etc)
  const { data: campRow } = await admin
    .from("campaigns")
    .select("campaign_id, name")
    .eq("user_id", userId)
    .eq("campaign_id", item.campaign_id)
    .maybeSingle();
  if (!campRow) return { error: "Campanha origem não encontrada no banco" };

  // Token
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: acc.refresh_token, grant_type: "refresh_token",
    }),
  });
  const tokJson = await tokRes.json();
  if (!tokRes.ok) return { error: `refresh failed: ${JSON.stringify(tokJson)}` };
  const accessToken = tokJson.access_token as string;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
    "Content-Type": "application/json",
  };
  if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;
  const apiBase = `https://googleads.googleapis.com/v21/customers/${acc.customer_id}`;

  // 1) Lê config completa da campanha origem
  const campQuery = `
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
           campaign.advertising_channel_sub_type, campaign.bidding_strategy_type,
           campaign.start_date, campaign.end_date,
           campaign.contains_eu_political_advertising,
           campaign.tracking_url_template, campaign.final_url_suffix,
           campaign.url_custom_parameters,
           campaign.network_settings.target_google_search,
           campaign.network_settings.target_search_network,
           campaign.network_settings.target_content_network,
           campaign.network_settings.target_partner_search_network,
           campaign.geo_target_type_setting.positive_geo_target_type,
           campaign.geo_target_type_setting.negative_geo_target_type,
           campaign.campaign_budget, campaign_budget.amount_micros,
           campaign_budget.delivery_method
    FROM campaign
    WHERE campaign.id = ${item.campaign_id}
  `;
  const cRes = await fetch(`${apiBase}/googleAds:search`, {
    method: "POST", headers, body: JSON.stringify({ query: campQuery }),
  });
  const cJson = await cRes.json();
  if (!cRes.ok) return { error: `read campaign: ${extractError(cJson)}`, debug: { step: "read_campaign", response: cJson } };
  const cRow = (cJson.results ?? [])[0];
  if (!cRow) return { error: "Campanha não encontrada no Google Ads" };

  const channelType: string = cRow.campaign?.advertisingChannelType ?? "DISPLAY";
  const channelSubType: string | undefined = cRow.campaign?.advertisingChannelSubType;
  const euPoliticalStatus: string = cRow.campaign?.containsEuPoliticalAdvertising === "CONTAINS_EU_POLITICAL_ADVERTISING"
    ? "CONTAINS_EU_POLITICAL_ADVERTISING"
    : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";
  const sourceNetwork = cRow.campaign?.networkSettings ?? {};
  const sourceGeoSetting = cRow.campaign?.geoTargetTypeSetting;
  const sourceTrackingTemplate: string | undefined = cRow.campaign?.trackingUrlTemplate;
  const sourceFinalUrlSuffix: string | undefined = cRow.campaign?.finalUrlSuffix;
  const sourceBudgetMicros = Number(cRow.campaignBudget?.amountMicros ?? 0);
  // UTMs padrão exigidas pelo usuário
  const STANDARD_FINAL_URL_SUFFIX =
    "utm_source=google&utm_campaign={campaignid}&utm_adgroup={adgroupid}&utm_content={creative}&utm_placement={campaignid}_{placement}";

  // Winner sempre nasce com Maximizar Conversões SEM CPA inicial.
  const biddingType: string = "MAXIMIZE_CONVERSIONS";
  const newBudgetMicros = 30_000_000;

  if (channelType === "PERFORMANCE_MAX") {
    return { error: "Campanhas Performance Max não são suportadas para duplicação automática (assets/asset groups requerem cópia manual)." };
  }

  // Validação de campos obrigatórios — para ajudar debug
  const missing: string[] = [];
  if (!acc.customer_id) missing.push("customer_id");
  if (!campRow.name) missing.push("campaign.name (origem)");
  if (!channelType) missing.push("advertising_channel_type");
  if (!item.country_criterion_id) missing.push("country_criterion_id");
  if (missing.length > 0) {
    return { error: `Campos obrigatórios ausentes: ${missing.join(", ")}`, debug: { missing } };
  }

  const newName = `${campRow.name} - ${(item.country_name ?? item.country_code).toUpperCase()} WINNER`;
  const tempBudgetId = `-${Date.now()}`;
  const tempCampaignId = `-${Date.now() + 1}`;

  // 2) Cria budget novo
  const budgetMutate = {
    operations: [{
      create: {
        resourceName: `customers/${acc.customer_id}/campaignBudgets/${tempBudgetId}`,
        name: `${newName} budget ${Date.now()}`,
        amountMicros: String(newBudgetMicros),
        deliveryMethod: cRow.campaignBudget?.deliveryMethod ?? "STANDARD",
        explicitlyShared: false,
      },
    }],
  };
  const bRes = await fetch(`${apiBase}/campaignBudgets:mutate`, {
    method: "POST", headers, body: JSON.stringify(budgetMutate),
  });
  const bJson = await bRes.json();
  if (!bRes.ok) return { error: `budget create: ${extractError(bJson)}`, debug: { step: "budget_create", payload: budgetMutate, response: bJson } };
  const newBudgetResource = bJson.results?.[0]?.resourceName;
  if (!newBudgetResource) return { error: "budget create: resourceName ausente", debug: bJson };

  // 3) Monta campanha PAUSED — copia network_settings da origem (obrigatório)
  const networkSettings = {
    targetGoogleSearch: sourceNetwork.targetGoogleSearch ?? (channelType === "SEARCH"),
    targetSearchNetwork: sourceNetwork.targetSearchNetwork ?? false,
    targetContentNetwork: sourceNetwork.targetContentNetwork ?? (channelType === "DISPLAY"),
    targetPartnerSearchNetwork: sourceNetwork.targetPartnerSearchNetwork ?? false,
  };

  const today = new Date();
  const startDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  const campCreate: any = {
    resourceName: `customers/${acc.customer_id}/campaigns/${tempCampaignId}`,
    name: newName,
    status: "PAUSED",
    advertisingChannelType: channelType,
    campaignBudget: newBudgetResource,
    containsEuPoliticalAdvertising: euPoliticalStatus,
    networkSettings,
    startDate,
    finalUrlSuffix: sourceFinalUrlSuffix && sourceFinalUrlSuffix.length > 0 ? sourceFinalUrlSuffix : STANDARD_FINAL_URL_SUFFIX,
  };
  if (sourceTrackingTemplate) campCreate.trackingUrlTemplate = sourceTrackingTemplate;
  // sub-type: só copia se for um valor válido em criação (alguns são read-only)
  if (channelSubType && !["DISPLAY_SMART_CAMPAIGN", "DISPLAY_MOBILE_APP"].includes(channelSubType)) {
    campCreate.advertisingChannelSubType = channelSubType;
  }
  if (sourceGeoSetting) {
    campCreate.geoTargetTypeSetting = {
      positiveGeoTargetType: sourceGeoSetting.positiveGeoTargetType ?? "PRESENCE_OR_INTEREST",
      negativeGeoTargetType: sourceGeoSetting.negativeGeoTargetType ?? "PRESENCE",
    };
  }

  // Bidding — Winner = MAXIMIZE_CONVERSIONS sem CPA
  campCreate.maximizeConversions = {};

  const campMutate = { operations: [{ create: campCreate }] };
  const ccRes = await fetch(`${apiBase}/campaigns:mutate`, {
    method: "POST", headers, body: JSON.stringify(campMutate),
  });
  const ccJson = await ccRes.json();
  if (!ccRes.ok) {
    console.error("[geo-expansion] campaign create failed", JSON.stringify(ccJson));
    return {
      error: `campaign create: ${extractError(ccJson)}`,
      debug: {
        step: "campaign_create",
        customer_id: acc.customer_id,
        source_campaign_id: item.campaign_id,
        new_name: newName,
        budget_resource_name: newBudgetResource,
        channel_type: channelType,
        channel_sub_type: channelSubType,
        bidding_strategy: biddingType,
        geo_target: item.country_criterion_id,
        status: "PAUSED",
        payload: campCreate,
        response: ccJson,
      },
    };
  }
  const newCampaignResource: string = ccJson.results?.[0]?.resourceName;
  const newCampaignId = newCampaignResource.split("/").pop()!;

  // 4) Adiciona criterion de location (somente winner)
  const critMutate = {
    operations: [{
      create: {
        campaign: newCampaignResource,
        location: { geoTargetConstant: `geoTargetConstants/${item.country_criterion_id.replace(/\D/g, "")}` },
      },
    }],
  };
  const crRes = await fetch(`${apiBase}/campaignCriteria:mutate`, {
    method: "POST", headers, body: JSON.stringify(critMutate),
  });
  const crJson = await crRes.json();
  if (!crRes.ok) {
    console.error("[geo-expansion] criterion failed", JSON.stringify(crJson));
  }

  // 5) Clona ad groups (nome, status PAUSED, target_cpa quando aplicável)
  const agQuery = `
    SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
           ad_group.cpc_bid_micros, ad_group.target_cpa_micros
    FROM ad_group
    WHERE ad_group.campaign = 'customers/${acc.customer_id}/campaigns/${item.campaign_id}'
      AND ad_group.status != 'REMOVED'
  `;
  const agRes = await fetch(`${apiBase}/googleAds:search`, {
    method: "POST", headers, body: JSON.stringify({ query: agQuery }),
  });
  const agJson = await agRes.json();
  const agRows = (agJson.results ?? []) as any[];

  const oldToNewAdGroup = new Map<string, string>();
  if (agRows.length > 0) {
    const ops = agRows.map((row, idx) => {
      const create: any = {
        resourceName: `customers/${acc.customer_id}/adGroups/-${Date.now() + 100 + idx}`,
        name: row.adGroup.name,
        campaign: newCampaignResource,
        status: "PAUSED",
        type: row.adGroup.type ?? "DISPLAY_STANDARD",
      };
      if (row.adGroup.cpcBidMicros) create.cpcBidMicros = String(row.adGroup.cpcBidMicros);
      if (row.adGroup.targetCpaMicros) create.targetCpaMicros = String(row.adGroup.targetCpaMicros);
      return { create };
    });
    const r = await fetch(`${apiBase}/adGroups:mutate`, {
      method: "POST", headers, body: JSON.stringify({ operations: ops }),
    });
    const j = await r.json();
    if (r.ok) {
      const results = j.results ?? [];
      agRows.forEach((row, i) => {
        const newRn = results[i]?.resourceName;
        if (newRn) oldToNewAdGroup.set(String(row.adGroup.id), newRn);
      });
    } else {
      console.error("[geo-expansion] ad_groups failed", JSON.stringify(j));
    }
  }

  // 6) Clona ads (responsive display ads suportados; outros tipos avisamos no log)
  let adsCloned = 0;
  let adsSkipped = 0;
  if (oldToNewAdGroup.size > 0) {
    const oldAdGroupIds = [...oldToNewAdGroup.keys()];
    const inList = oldAdGroupIds.map((x) => `'customers/${acc.customer_id}/adGroups/${x}'`).join(",");
    const adQuery = `
      SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name,
             ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls,
             ad_group_ad.ad.responsive_display_ad.headlines,
             ad_group_ad.ad.responsive_display_ad.long_headline,
             ad_group_ad.ad.responsive_display_ad.descriptions,
             ad_group_ad.ad.responsive_display_ad.business_name,
             ad_group_ad.ad.responsive_display_ad.marketing_images,
             ad_group_ad.ad.responsive_display_ad.square_marketing_images,
             ad_group_ad.ad.responsive_display_ad.logo_images,
             ad_group_ad.ad.responsive_display_ad.youtube_videos,
             ad_group_ad.ad.responsive_display_ad.call_to_action_text,
             ad_group_ad.ad.responsive_search_ad.headlines,
             ad_group_ad.ad.responsive_search_ad.descriptions,
             ad_group_ad.ad.responsive_search_ad.path1,
             ad_group_ad.ad.responsive_search_ad.path2
      FROM ad_group_ad
      WHERE ad_group_ad.ad_group IN (${inList})
        AND ad_group_ad.status != 'REMOVED'
    `;
    const adRes = await fetch(`${apiBase}/googleAds:search`, {
      method: "POST", headers, body: JSON.stringify({ query: adQuery }),
    });
    const adJson = await adRes.json();
    const adRows = (adJson.results ?? []) as any[];
    const ops: any[] = [];
    for (const row of adRows) {
      const newAdGroupRn = oldToNewAdGroup.get(String(row.adGroup.id));
      if (!newAdGroupRn) continue;
      const ad = row.adGroupAd?.ad ?? {};
      const adCreate: any = { name: ad.name };
      if (ad.finalUrls) adCreate.finalUrls = ad.finalUrls;
      if (ad.finalMobileUrls) adCreate.finalMobileUrls = ad.finalMobileUrls;
      if (ad.responsiveDisplayAd) {
        adCreate.responsiveDisplayAd = ad.responsiveDisplayAd;
      } else if (ad.responsiveSearchAd) {
        adCreate.responsiveSearchAd = ad.responsiveSearchAd;
      } else {
        adsSkipped++;
        continue;
      }
      ops.push({
        create: {
          adGroup: newAdGroupRn,
          status: "PAUSED",
          ad: adCreate,
        },
      });
    }
    if (ops.length > 0) {
      // mutate em chunks de 100
      for (const chunk of chunkArr(ops, 100)) {
        const r = await fetch(`${apiBase}/adGroupAds:mutate`, {
          method: "POST", headers, body: JSON.stringify({ operations: chunk, partialFailure: true }),
        });
        const j = await r.json();
        if (r.ok) {
          adsCloned += (j.results ?? []).filter((x: any) => x?.resourceName).length;
        } else {
          console.error("[geo-expansion] ads failed", JSON.stringify(j));
        }
      }
    }
  }

  // 7) Log
  await admin.from("campaign_expansion_logs").insert({
    user_id: userId,
    site_id: siteId,
    google_account_id: item.google_account_id,
    original_campaign_id: item.campaign_id,
    original_campaign_name: campRow.name,
    new_campaign_id: newCampaignId,
    new_campaign_name: newName,
    country_code: item.country_code,
    country_name: item.country_name,
    country_criterion_id: item.country_criterion_id,
    roi_pct: item.roi_pct,
    cost_brl: item.cost_brl,
    revenue_brl: item.revenue_brl,
    budget_micros: newBudgetMicros,
    action: "created",
    status: "executed",
    payload: { ad_groups: oldToNewAdGroup.size, ads_cloned: adsCloned, ads_skipped: adsSkipped, source_budget_micros: sourceBudgetMicros },
  });

  // 8) Insere também no campaigns local (para aparecer na UI)
  await admin.from("campaigns").insert({
    user_id: userId,
    google_account_id: item.google_account_id,
    campaign_id: newCampaignId,
    name: newName,
    status: "paused",
    channel_type: channelType,
    budget_micros: newBudgetMicros,
  });

  // 9) Seed lifecycle "winner_test" — automação padrão NÃO mexe nessa campanha.
  //    O winner_started_at só é setado quando o usuário ativar (status=enabled).
  await admin.from("campaign_automation").insert({
    user_id: userId,
    google_account_id: item.google_account_id,
    site_id: siteId,
    campaign_id: newCampaignId,
    lifecycle_status: "winner_test",
    winner_country_code: item.country_code,
    winner_started_at: null,
  });

  return {
    ok: true,
    new_campaign_id: newCampaignId,
    new_campaign_name: newName,
    budget_micros: newBudgetMicros,
    ad_groups_cloned: oldToNewAdGroup.size,
    ads_cloned: adsCloned,
    ads_skipped: adsSkipped,
  };
}

function extractError(j: any): string {
  return j?.error?.details?.[0]?.errors?.[0]?.message ?? j?.error?.message ?? JSON.stringify(j);
}

function chunkArr<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function round(n: number) { return Math.round(n * 100) / 100; }

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
