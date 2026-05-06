// Expansão por país vencedor: identifica winners e (opcional) duplica campanha
// no Google Ads, focada apenas no país vencedor, em modo PAUSED.
//
// Modos:
//  - preview : retorna lista de winners com base em campaign_country_metrics + daily_metrics
//  - apply   : duplica a campanha (cria budget + campaign + ad_groups + ads + location criterion)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { getRevSharePct } from "../_shared/revshare.ts";
import { computeCountryPerformance } from "../_shared/country_performance.ts";

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
    const budgetMultiplier = 1;
    const fxUsdBrl = Number(body?.fx_usd_brl ?? 5);
    const targetUserId: string | undefined = body?.user_id;
    const siteId: string | null =
      typeof body?.site_id === "string" && body.site_id && body.site_id !== "all" ? body.site_id : null;
    const requestedAccountIds = Array.isArray(body?.account_ids)
      ? [...new Set(body.account_ids.map((id: unknown) => String(id)).filter(Boolean))]
      : [];
    const requestedCampaignIds = Array.isArray(body?.campaign_ids)
      ? [...new Set(body.campaign_ids.map((id: unknown) => String(id)).filter(Boolean))]
      : [];

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
      const startStatus: "PAUSED" = "PAUSED";
      if (!item?.campaign_id || !item?.country_criterion_id || !item?.google_account_id) {
        return json({ error: "item inválido (campaign_id, google_account_id, country_criterion_id obrigatórios)" });
      }
      const result = await duplicateCampaign(admin, userId!, item, budgetMultiplier, siteId, startStatus);
      return json(result);
    }

    // ===== PREVIEW: lista winners =====
    const today = new Date();
    const toDate = new Date(today.getTime() - 86400_000);
    const fromDate = new Date(today.getTime() - lookbackDays * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const from = iso(fromDate);
    const to = iso(toDate);

    // ===== PREVIEW: lista winners usando engine compartilhada =====
    const result = await computeCountryPerformance({
      admin, userId: userId!, siteId,
      accountIds: requestedAccountIds.length > 0 ? requestedAccountIds : null,
      campaignIds: requestedCampaignIds.length > 0 ? requestedCampaignIds : null,
      from, to, fxUsdBrl, netFactor: NET_FACTOR,
    });

    if (result.cells.size === 0) {
      return json({ ok: true, items: [], stats: { period: { from, to }, info: "Sem dados na janela selecionada", meta: result.meta } });
    }

    // Carrega metadados das campanhas (nome, status, budget) — apenas para as encontradas
    const foundCampaignIds = [...result.campaignTotals.keys()];
    const campMap = new Map<string, { name: string; google_account_id: string; budget_micros: number | null; status: string }>();
    for (const chunk of chunkArr(foundCampaignIds, 200)) {
      const { data } = await admin.from("campaigns")
        .select("campaign_id, name, status, google_account_id, budget_micros")
        .eq("user_id", userId!)
        .in("campaign_id", chunk);
      for (const c of data ?? []) {
        if (!c.google_account_id) continue;
        campMap.set(String(c.campaign_id), {
          name: c.name,
          google_account_id: String(c.google_account_id),
          budget_micros: c.budget_micros ? Number(c.budget_micros) : null,
          status: String(c.status ?? "enabled"),
        });
      }
    }

    // Lifecycle (bloquear testing)
    const testingIds = new Set<string>();
    for (const chunk of chunkArr(foundCampaignIds, 200)) {
      const { data } = await admin
        .from("campaign_automation")
        .select("campaign_id, lifecycle_status")
        .eq("user_id", userId!)
        .in("campaign_id", chunk);
      for (const r of data ?? []) {
        if (String(r.lifecycle_status ?? "").toLowerCase() === "testing") testingIds.add(String(r.campaign_id));
      }
    }

    // Funil Inteligente: campanhas em aprendizado/escala estão isoladas
    const funnelLockedIds = new Set<string>();
    for (const chunk of chunkArr(foundCampaignIds, 200)) {
      const { data } = await admin
        .from("campaign_funnel")
        .select("campaign_id, funnel_status")
        .eq("user_id", userId!)
        .in("campaign_id", chunk)
        .not("funnel_status", "in", "(graduated,failed-learning)");
      for (const r of data ?? []) funnelLockedIds.add(String(r.campaign_id));
    }

    // Já expandidas (evitar loop)
    const alreadyExpanded = new Set<string>();
    {
      let q = admin.from("campaign_expansion_logs")
        .select("original_campaign_id, country_code, action")
        .eq("user_id", userId!).eq("action", "created");
      q = siteId ? q.eq("site_id", siteId) : q.is("site_id", null);
      const { data } = await q;
      for (const r of data ?? []) alreadyExpanded.add(`${r.original_campaign_id}|${r.country_code}`);
    }

    interface Winner {
      campaign_id: string; campaign_name: string; google_account_id: string;
      country_code: string; country_name: string; country_criterion_id: string | null;
      cost_brl: number; revenue_brl: number; roi_pct: number;
      campaign_cost_brl: number; countries_in_campaign: number;
      budget_micros: number | null;
    }
    interface Candidate extends Winner { reject_reasons: string[]; }
    const winners: Winner[] = [];
    const rejected: Candidate[] = [];
    const rejectionCounts: Record<string, number> = {};
    const addReject = (reason: string) => { rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1; };

    for (const cell of result.cells.values()) {
      const meta = campMap.get(cell.campaign_id);
      if (!meta || meta.status !== "enabled") continue;
      const camp = result.campaignTotals.get(cell.campaign_id)!;
      const profit = cell.revenue_brl - cell.cost_brl;
      const roi = cell.cost_brl > 0 ? (profit / cell.cost_brl) * 100 : 0;
      const candidate: Winner = {
        campaign_id: cell.campaign_id,
        campaign_name: meta.name,
        google_account_id: meta.google_account_id,
        country_code: cell.country_code,
        country_name: cell.country_name,
        country_criterion_id: cell.country_criterion_id,
        cost_brl: round(cell.cost_brl),
        revenue_brl: round(cell.revenue_brl),
        roi_pct: round(roi),
        campaign_cost_brl: round(camp.cost_brl),
        countries_in_campaign: camp.countries.size,
        budget_micros: meta.budget_micros,
      };
      const reasons: string[] = [];
      if (testingIds.has(cell.campaign_id)) reasons.push("campanha em testing");
      if (camp.countries.size < minCountries) reasons.push(`mín. países ${camp.countries.size}/${minCountries}`);
      if (camp.cost_brl < minCampaignCost) reasons.push(`custo campanha ${round(camp.cost_brl)} < ${minCampaignCost}`);
      if (cell.cost_brl < minCountryCost) reasons.push(`custo país ${round(cell.cost_brl)} < ${minCountryCost}`);
      if (alreadyExpanded.has(`${cell.campaign_id}|${cell.country_code}`)) reasons.push("já expandida");
      if (!cell.country_criterion_id) reasons.push("sem critério de país");
      if (roi < minRoi) reasons.push(`ROI ${round(roi)} < ${minRoi}`);
      if (reasons.length === 0) winners.push(candidate);
      else {
        for (const reason of reasons) addReject(reason);
        rejected.push({ ...candidate, reject_reasons: reasons });
      }
    }
    winners.sort((a, b) => b.roi_pct - a.roi_pct);
    rejected.sort((a, b) => b.roi_pct - a.roi_pct);

    return json({
      ok: true,
      items: winners,
      stats: {
        period: { from, to },
        total: winners.length,
        filters: { min_roi_pct: minRoi, min_campaign_cost_brl: minCampaignCost, min_country_cost_brl: minCountryCost, min_countries: minCountries, lookback_days: lookbackDays },
        candidates_total: winners.length + rejected.length,
        rejection_counts: rejectionCounts,
        top_candidates: rejected.slice(0, 10),
        engine_meta: result.meta,
        warnings: result.warnings,
      },
    });
  } catch (e) {
    console.error("[geo-expansion]", e);
    return json({ error: String(e) });
  }
});

// ===== Duplicate campaign =====
async function duplicateCampaign(
  admin: any, userId: string, item: ApplyItem, _budgetMultiplier: number, siteId: string | null,
  startStatus: "PAUSED" = "PAUSED",
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
  const sourceCampaignResource = `customers/${acc.customer_id}/campaigns/${item.campaign_id}`;

  // 1) Lê config completa da campanha origem
  const campQuery = `
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
           campaign.advertising_channel_sub_type, campaign.bidding_strategy,
           campaign.bidding_strategy_type,
           campaign.manual_cpc.enhanced_cpc_enabled,
           campaign.maximize_conversions.target_cpa_micros,
           campaign.maximize_conversion_value.target_roas,
           campaign.target_cpa.target_cpa_micros,
           campaign.target_roas.target_roas,
           campaign.target_spend.target_spend_micros,
           campaign.target_spend.cpc_bid_ceiling_micros,
           campaign.target_impression_share.location,
           campaign.target_impression_share.location_fraction_micros,
           campaign.target_impression_share.cpc_bid_ceiling_micros,
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
  const cRows = await googleAdsSearchAll(apiBase, headers, campQuery).catch((e) => {
    throw new CloneError("read_campaign", `read campaign: ${extractError(e.response ?? e)}`, e.response ?? e);
  });
  const cRow = cRows[0];
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

  const sourceBiddingType: string = cRow.campaign?.biddingStrategyType ?? "UNKNOWN";
  const biddingConfig = buildWinnerBidding(sourceBiddingType);
  const newBudgetMicros = 30_000_000;

  if (channelType === "PERFORMANCE_MAX") {
    return { error: "Campanhas Performance Max não são suportadas para duplicação automática (asset groups exigem fluxo próprio da API)." };
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

  const nameSuffix = (() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  })();
  const newName = `${campRow.name} - ${(item.country_name ?? item.country_code).toUpperCase()} WINNER #${nameSuffix}`;
  const requestSeed = Date.now();
  const tempBudgetId = `-${requestSeed}`;
  const tempCampaignId = `-${requestSeed + 1}`;

  const debug: any = {
    source_campaign_id: item.campaign_id,
    new_campaign_name: newName,
    requested_country: item.country_criterion_id,
    budget_micros: newBudgetMicros,
    source_bidding_strategy: sourceBiddingType,
    bidding_strategy: biddingConfig.debug.applied,
    source: {},
    cloned: {},
    skipped: {},
    partial_failures: [],
  };

  // Lê elementos da origem ANTES de criar a campanha nova. Se a origem não tiver ads/ad groups, não cria vazio.
  const agRows = await googleAdsSearchAll(apiBase, headers, `
    SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
           ad_group.tracking_url_template, ad_group.final_url_suffix,
           ad_group.url_custom_parameters
    FROM ad_group
    WHERE ad_group.campaign = '${sourceCampaignResource}'
      AND ad_group.status != 'REMOVED'
  `).catch((e) => {
    throw new CloneError("read_ad_groups", `read ad groups: ${extractError(e.response ?? e)}`, e.response ?? e);
  });
  debug.source.ad_groups = agRows.length;
  if (agRows.length === 0) {
    return { error: "Campanha origem não possui grupos de anúncios ativos para clonar; nada foi criado.", debug };
  }

  const sourceAdGroupIds = agRows.map((r: any) => String(r.adGroup?.id)).filter(Boolean);
  const sourceAdGroupResources = sourceAdGroupIds.map((id: string) => `'customers/${acc.customer_id}/adGroups/${id}'`).join(",");
  const adRows = await googleAdsSearchAll(apiBase, headers, `
    SELECT ad_group.id, ad_group_ad.status,
           ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name,
           ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls,
           ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.final_url_suffix,
           ad_group_ad.ad.url_custom_parameters,
           ad_group_ad.ad.responsive_display_ad.headlines,
           ad_group_ad.ad.responsive_display_ad.long_headline,
           ad_group_ad.ad.responsive_display_ad.descriptions,
           ad_group_ad.ad.responsive_display_ad.business_name,
           ad_group_ad.ad.responsive_display_ad.marketing_images,
           ad_group_ad.ad.responsive_display_ad.square_marketing_images,
           ad_group_ad.ad.responsive_display_ad.logo_images,
           ad_group_ad.ad.responsive_display_ad.square_logo_images,
           ad_group_ad.ad.responsive_display_ad.youtube_videos,
           ad_group_ad.ad.responsive_display_ad.call_to_action_text,
           ad_group_ad.ad.responsive_display_ad.allow_flexible_color,
           ad_group_ad.ad.responsive_display_ad.accent_color,
           ad_group_ad.ad.responsive_display_ad.main_color,
           ad_group_ad.ad.responsive_display_ad.format_setting,
           ad_group_ad.ad.responsive_search_ad.headlines,
           ad_group_ad.ad.responsive_search_ad.descriptions,
           ad_group_ad.ad.responsive_search_ad.path1,
           ad_group_ad.ad.responsive_search_ad.path2,
           ad_group_ad.ad.display_upload_ad.media_bundle,
           ad_group_ad.ad.display_upload_ad.display_upload_product_type
    FROM ad_group_ad
    WHERE ad_group_ad.ad_group IN (${sourceAdGroupResources})
      AND ad_group_ad.status != 'REMOVED'
  `).catch((e) => {
    throw new CloneError("read_ads", `read ads: ${extractError(e.response ?? e)}`, e.response ?? e);
  });
  debug.source.ads = adRows.length;
  if (adRows.length === 0) {
    return { error: "Campanha origem não possui anúncios/criativos ativos para clonar; nada foi criado.", debug };
  }

  const campaignCriteriaRows = await readCampaignCriteria(apiBase, headers, sourceCampaignResource, item.campaign_id, debug);
  const sourceCriteriaSummary = summarizeCampaignCriteria(campaignCriteriaRows);
  debug.source.campaign_criteria = campaignCriteriaRows.length;
  debug.source.language_constants = sourceCriteriaSummary.languageConstants;
  debug.source.languages_found = sourceCriteriaSummary.languageConstants.length;
  debug.source.active_devices = sourceCriteriaSummary.activeDevices;
  debug.source.device_bid_modifiers = sourceCriteriaSummary.deviceBidModifiers;
  debug.pre_create = {
    languages_found: sourceCriteriaSummary.languageConstants,
    devices_found: sourceCriteriaSummary.activeDevices,
    device_bid_modifiers_found: sourceCriteriaSummary.deviceBidModifiers,
    bidding_applied: biddingConfig.debug,
    ad_groups_to_copy: agRows.length,
    ads_to_copy: adRows.length,
    budget_micros: newBudgetMicros,
    status: "PAUSED",
  };
  console.log("[geo-expansion] pre-create clone debug", JSON.stringify(debug.pre_create));

  const languageValidation = validateSourceLanguages(sourceCriteriaSummary);
  if (!languageValidation.ok) return { error: `${languageValidation.reason}; nada foi criado.`, debug };

  let newCampaignResource = "";
  let newCampaignId = "";

  try {
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
    if (!bRes.ok) return { error: `budget create: ${extractError(bJson)}`, debug: { ...debug, step: "budget_create", payload: budgetMutate, response: bJson } };
    const newBudgetResource = bJson.results?.[0]?.resourceName;
    if (!newBudgetResource) return { error: "budget create: resourceName ausente", debug: bJson };

    // 3) Monta campanha — copia settings principais da origem, alterando só nome/geo/budget/bidding.
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
    if (cRow.campaign?.urlCustomParameters) campCreate.urlCustomParameters = cRow.campaign.urlCustomParameters;
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

    Object.assign(campCreate, biddingConfig.createFields);

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
          ...debug,
          step: "campaign_create",
          customer_id: acc.customer_id,
          source_campaign_id: item.campaign_id,
          new_name: newName,
          budget_resource_name: newBudgetResource,
          channel_type: channelType,
          channel_sub_type: channelSubType,
          source_bidding_strategy: sourceBiddingType,
          bidding_strategy: biddingConfig.debug.applied,
          contains_eu_political_advertising: euPoliticalStatus,
          geo_target: item.country_criterion_id,
          status: "PAUSED",
          payload: campCreate,
          response: ccJson,
        },
      };
    }
    newCampaignResource = ccJson.results?.[0]?.resourceName;
    newCampaignId = newCampaignResource?.split("/").pop() ?? "";
    if (!newCampaignResource || !newCampaignId) {
      return { error: "campaign create: resourceName ausente", debug: { ...debug, response: ccJson } };
    }

    // 4) Geo: SOMENTE país vencedor (não copia locations/proximities da origem).
    const winnerGeoConstant = `geoTargetConstants/${item.country_criterion_id.replace(/\D/g, "")}`;
    const cr = await mutateGoogle(apiBase, headers, "campaignCriteria", [{
      create: { campaign: newCampaignResource, location: { geoTargetConstant: winnerGeoConstant } },
    }], "winner_geo");
    debug.cloned.geo_targets = cr.created;
    if (cr.partialFailureError) debug.partial_failures.push({ step: "winner_geo", response: cr.partialFailureError });

    // 5) Clona campaign criteria não geográficos: idioma, agenda, dispositivos, audiences etc.
    const campaignCriterionOps: any[] = [];
    const campaignCriterionCounts: Record<string, number> = {};
    for (const row of campaignCriteriaRows) {
      const op = buildCriterionOperation("campaign", row.campaignCriterion, newCampaignResource, { skipGeo: true });
      if (!op) {
        const type = row.campaignCriterion?.type ?? "UNKNOWN";
        debug.skipped[`campaign_criterion_${type}`] = (debug.skipped[`campaign_criterion_${type}`] ?? 0) + 1;
        continue;
      }
      campaignCriterionOps.push(op);
      const type = row.campaignCriterion?.type ?? "UNKNOWN";
      campaignCriterionCounts[type] = (campaignCriterionCounts[type] ?? 0) + 1;
    }
    const campaignCriteriaResult = await mutateGoogle(apiBase, headers, "campaignCriteria", campaignCriterionOps, "campaign_criteria");
    const clonedCriteriaSummary = summarizeCampaignCriteria(await readCampaignCriteria(apiBase, headers, newCampaignResource, newCampaignId, debug));
    debug.source.campaign_criteria = campaignCriteriaRows.length;
    debug.cloned.campaign_criteria = campaignCriteriaResult.created;
    debug.cloned.languages = clonedCriteriaSummary.languageConstants.length;
    debug.cloned.ad_schedules = campaignCriterionCounts.AD_SCHEDULE ?? 0;
    debug.cloned.devices = clonedCriteriaSummary.activeDevices.length;
    debug.cloned.language_constants = clonedCriteriaSummary.languageConstants;
    debug.cloned.active_devices = clonedCriteriaSummary.activeDevices;
    debug.cloned.device_bid_modifiers = clonedCriteriaSummary.deviceBidModifiers;
    debug.cloned.network_settings = networkSettings;
    debug.cloned.bidding = biddingConfig.debug;
    if (campaignCriteriaResult.partialFailureError) debug.partial_failures.push({ step: "campaign_criteria", response: campaignCriteriaResult.partialFailureError });
    const criticalCriteriaOk = compareCampaignCriteriaSummary(sourceCriteriaSummary, clonedCriteriaSummary);
    debug.validation = { ...(debug.validation ?? {}), campaign_criteria: criticalCriteriaOk };
    if (!criticalCriteriaOk.ok) {
      await removeCampaign(apiBase, headers, newCampaignResource);
      return { error: `campaign_criteria: idioma/dispositivo não foi clonado fielmente (${criticalCriteriaOk.reason}); campanha removida para evitar broad/open.`, debug };
    }

    // 6) Clona campaign assets/extensões
    const campaignAssetRows = await readCampaignAssets(apiBase, headers, sourceCampaignResource, debug);
    const campaignAssetOps = campaignAssetRows.map((row: any) => ({
      create: cleanObject({
        campaign: newCampaignResource,
        asset: row.campaignAsset?.asset,
        fieldType: row.campaignAsset?.fieldType,
        status: row.campaignAsset?.status,
      }),
    })).filter((op: any) => op.create.asset && op.create.fieldType);
    const campaignAssetResult = await mutateGoogle(apiBase, headers, "campaignAssets", campaignAssetOps, "campaign_assets");
    debug.source.campaign_assets = campaignAssetRows.length;
    debug.cloned.campaign_assets = campaignAssetResult.created;
    if (campaignAssetResult.partialFailureError) debug.partial_failures.push({ step: "campaign_assets", response: campaignAssetResult.partialFailureError });

    // 7) Clona ad groups com status/config original (sem lances incompatíveis com Maximizar Conversões).
    const oldToNewAdGroup = new Map<string, string>();
    const agOps = agRows.map((row: any, idx: number) => ({
      create: cleanObject({
        resourceName: `customers/${acc.customer_id}/adGroups/-${requestSeed + 100 + idx}`,
        name: row.adGroup.name,
        campaign: newCampaignResource,
        status: row.adGroup.status ?? "ENABLED",
        type: row.adGroup.type ?? "DISPLAY_STANDARD",
        trackingUrlTemplate: row.adGroup.trackingUrlTemplate,
        finalUrlSuffix: row.adGroup.finalUrlSuffix,
        urlCustomParameters: row.adGroup.urlCustomParameters,
      }),
    }));
    const agResult = await mutateGoogle(apiBase, headers, "adGroups", agOps, "ad_groups");
    agRows.forEach((row: any, i: number) => {
      const newRn = agResult.results[i]?.resourceName;
      if (newRn) oldToNewAdGroup.set(String(row.adGroup.id), newRn);
    });
    debug.cloned.ad_groups = oldToNewAdGroup.size;
    if (agResult.partialFailureError) debug.partial_failures.push({ step: "ad_groups", response: agResult.partialFailureError });
    if (oldToNewAdGroup.size === 0) {
      await removeCampaign(apiBase, headers, newCampaignResource);
      return {
        error: `ad_groups: nenhum grupo de anúncios foi clonado (${extractError(agResult.partialFailureError ?? {})}); campanha vazia removida.`,
        debug: { ...debug, step: "ad_groups_create", response: agResult.partialFailureError },
      };
    }

    // 8) Clona ad group criteria: keywords, placements, audiences, topics etc.
    const adGroupCriteriaRows = await readAdGroupCriteria(apiBase, headers, sourceAdGroupResources, debug);
    const adGroupCriterionOps: any[] = [];
    const adGroupCriterionCounts: Record<string, number> = {};
    for (const row of adGroupCriteriaRows) {
      const newAdGroupRn = oldToNewAdGroup.get(String(row.adGroup?.id));
      if (!newAdGroupRn) continue;
      const op = buildCriterionOperation("adGroup", row.adGroupCriterion, newAdGroupRn, { skipGeo: false });
      if (!op) {
        const type = row.adGroupCriterion?.type ?? "UNKNOWN";
        debug.skipped[`ad_group_criterion_${type}`] = (debug.skipped[`ad_group_criterion_${type}`] ?? 0) + 1;
        continue;
      }
      adGroupCriterionOps.push(op);
      const type = row.adGroupCriterion?.type ?? "UNKNOWN";
      adGroupCriterionCounts[type] = (adGroupCriterionCounts[type] ?? 0) + 1;
    }
    const adGroupCriteriaResult = await mutateGoogle(apiBase, headers, "adGroupCriteria", adGroupCriterionOps, "ad_group_criteria");
    debug.source.ad_group_criteria = adGroupCriteriaRows.length;
    debug.cloned.ad_group_criteria = adGroupCriteriaResult.created;
    debug.cloned.keywords = adGroupCriterionCounts.KEYWORD ?? 0;
    debug.cloned.placements = adGroupCriterionCounts.PLACEMENT ?? 0;
    debug.cloned.audiences = (adGroupCriterionCounts.USER_LIST ?? 0) + (adGroupCriterionCounts.AUDIENCE ?? 0) + (adGroupCriterionCounts.COMBINED_AUDIENCE ?? 0) + (adGroupCriterionCounts.CUSTOM_AUDIENCE ?? 0);
    if (adGroupCriteriaResult.partialFailureError) debug.partial_failures.push({ step: "ad_group_criteria", response: adGroupCriteriaResult.partialFailureError });

    // 9) Clona ad group assets/extensões
    const adGroupAssetRows = await readAdGroupAssets(apiBase, headers, sourceAdGroupResources, debug);
    const adGroupAssetOps: any[] = [];
    for (const row of adGroupAssetRows) {
      const newAdGroupRn = oldToNewAdGroup.get(String(row.adGroup?.id));
      if (!newAdGroupRn) continue;
      const create = cleanObject({
        adGroup: newAdGroupRn,
        asset: row.adGroupAsset?.asset,
        fieldType: row.adGroupAsset?.fieldType,
        status: row.adGroupAsset?.status,
      });
      if (create.asset && create.fieldType) adGroupAssetOps.push({ create });
    }
    const adGroupAssetResult = await mutateGoogle(apiBase, headers, "adGroupAssets", adGroupAssetOps, "ad_group_assets");
    debug.source.ad_group_assets = adGroupAssetRows.length;
    debug.cloned.ad_group_assets = adGroupAssetResult.created;
    if (adGroupAssetResult.partialFailureError) debug.partial_failures.push({ step: "ad_group_assets", response: adGroupAssetResult.partialFailureError });

    // 10) Clona ads/criativos. Reusa os assets existentes da conta para manter imagens/logos/vídeos idênticos.
    const assetRefsInAds = new Set<string>();
    let adsSkipped = 0;
    const adOps: any[] = [];
    for (const row of adRows) {
      const newAdGroupRn = oldToNewAdGroup.get(String(row.adGroup?.id));
      if (!newAdGroupRn) continue;
      const ad = row.adGroupAd?.ad ?? {};
      const adCreate = buildAdCreate(ad, assetRefsInAds);
      if (!adCreate) {
        adsSkipped++;
        const type = ad.type ?? "UNKNOWN";
        debug.skipped[`ad_${type}`] = (debug.skipped[`ad_${type}`] ?? 0) + 1;
        continue;
      }
      adOps.push({
        create: {
          adGroup: newAdGroupRn,
          status: row.adGroupAd?.status ?? "ENABLED",
          ad: adCreate,
        },
      });
    }
    const adsResult = await mutateGoogle(apiBase, headers, "adGroupAds", adOps, "ads");
    const adsCloned = adsResult.created;
    if (adsResult.partialFailureError) debug.partial_failures.push({ step: "ads", response: adsResult.partialFailureError });
    debug.cloned.ads = adsCloned;
    debug.skipped.ads = adsSkipped;
    debug.cloned.assets_from_ads = assetRefsInAds.size;
    debug.cloned.assets_total = assetRefsInAds.size + campaignAssetResult.created + adGroupAssetResult.created;

    if (adsCloned === 0) {
      await removeCampaign(apiBase, headers, newCampaignResource);
      return {
        error: `ads: nenhum anúncio/criativo foi clonado (${extractError(adsResult.partialFailureError ?? {})}); campanha vazia removida.`,
        debug: { ...debug, step: "ads_create", response: adsResult.partialFailureError },
      };
    }

    const finalValidation = await validateClonedWinner(apiBase, headers, newCampaignResource, newCampaignId, sourceCriteriaSummary, debug);
    debug.validation = { ...(debug.validation ?? {}), final: finalValidation };
    if (!finalValidation.ok) {
      await removeCampaign(apiBase, headers, newCampaignResource);
      return { error: `validação final falhou: ${finalValidation.reason}; campanha removida.`, debug };
    }

    console.log("[geo-expansion] clone debug", JSON.stringify({
      new_campaign_id: newCampaignId,
      ad_groups_cloned: oldToNewAdGroup.size,
      ads_cloned: adsCloned,
      assets_cloned: debug.cloned.assets_total,
      languages_copied: debug.cloned.languages,
      language_constants: debug.cloned.language_constants,
      active_devices: debug.cloned.active_devices,
      device_bid_modifiers: debug.cloned.device_bid_modifiers,
      bidding_applied: debug.cloned.bidding,
      network_settings: debug.cloned.network_settings,
      keywords_copied: debug.cloned.keywords,
      placements_copied: debug.cloned.placements,
    }));

    // 11) Log
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
      payload: {
        ad_groups: oldToNewAdGroup.size,
        ads_cloned: adsCloned,
        ads_skipped: adsSkipped,
        assets_cloned: debug.cloned.assets_total,
        languages: debug.cloned.languages,
        language_constants: debug.cloned.language_constants,
        active_devices: debug.cloned.active_devices,
        device_bid_modifiers: debug.cloned.device_bid_modifiers,
        network_settings: debug.cloned.network_settings,
        bidding: debug.cloned.bidding,
        keywords: debug.cloned.keywords,
        placements: debug.cloned.placements,
        source_budget_micros: sourceBudgetMicros,
        debug,
      },
    });

    // 12) Insere também no campaigns local (para aparecer na UI)
    await admin.from("campaigns").insert({
      user_id: userId,
      google_account_id: item.google_account_id,
      campaign_id: newCampaignId,
      name: newName,
      status: "paused",
      channel_type: channelType,
      budget_micros: newBudgetMicros,
    });

    // 13) Seed lifecycle "winner_test" — automação padrão NÃO mexe nessa campanha.
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
      assets_cloned: debug.cloned.assets_total,
      languages_copied: debug.cloned.languages,
      language_constants: debug.cloned.language_constants,
      active_devices: debug.cloned.active_devices,
      device_bid_modifiers: debug.cloned.device_bid_modifiers,
      network_settings: debug.cloned.network_settings,
      keywords_copied: debug.cloned.keywords,
      placements_copied: debug.cloned.placements,
      campaign_criteria_cloned: debug.cloned.campaign_criteria,
      ad_group_criteria_cloned: debug.cloned.ad_group_criteria,
      debug,
    };
  } catch (e) {
    if (newCampaignResource) await removeCampaign(apiBase, headers, newCampaignResource);
    if (e instanceof CloneError) {
      return { error: e.message, debug: { ...debug, step: e.step, response: e.response, cleanup: newCampaignResource ? "campaign_removed" : "not_created" } };
    }
    return { error: String(e), debug: { ...debug, cleanup: newCampaignResource ? "campaign_removed" : "not_created" } };
  }
}

class CloneError extends Error {
  step: string;
  response: any;
  constructor(step: string, message: string, response?: any) {
    super(message);
    this.step = step;
    this.response = response;
  }
}

async function googleAdsSearchAll(apiBase: string, headers: Record<string, string>, query: string): Promise<any[]> {
  // Usa searchStream — não suporta nem requer pageSize, retorna tudo em batches.
  const res = await fetch(`${apiBase}/googleAds:searchStream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    const err: any = new Error(extractError(parsed) || `searchStream failed: ${res.status}`);
    err.response = parsed;
    err.query = query;
    throw err;
  }
  const rows: any[] = [];
  // searchStream retorna um array de respostas, cada uma com results
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  for (const b of batches) {
    if (b?.results) rows.push(...b.results);
  }
  return rows;
}

async function mutateGoogle(apiBase: string, headers: Record<string, string>, resource: string, operations: any[], step: string) {
  const results: any[] = [];
  let partialFailureError: any = null;
  if (operations.length === 0) return { created: 0, results, partialFailureError };
  for (const chunk of chunkArr(operations, 100)) {
    const res = await fetch(`${apiBase}/${resource}:mutate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operations: chunk, partialFailure: true }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.error(`[geo-expansion] ${step} failed`, JSON.stringify(json));
      partialFailureError = json;
      continue;
    }
    results.push(...(json.results ?? []));
    if (json.partialFailureError) {
      console.error(`[geo-expansion] ${step} partial failure`, JSON.stringify(json.partialFailureError));
      partialFailureError = json.partialFailureError;
    }
  }
  return { created: results.filter((x: any) => x?.resourceName).length, results, partialFailureError };
}

async function removeCampaign(apiBase: string, headers: Record<string, string>, campaignResource: string) {
  if (!campaignResource) return;
  try {
    await fetch(`${apiBase}/campaigns:mutate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operations: [{ update: { resourceName: campaignResource, status: "REMOVED" }, updateMask: "status" }],
        partialFailure: true,
      }),
    });
  } catch (e) {
    console.error("[geo-expansion] cleanup remove campaign failed", String(e));
  }
}

async function readCampaignCriteria(apiBase: string, headers: Record<string, string>, campaignResource: string, _campaignId: string, debug: any) {
  const base = "campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.status, campaign_criterion.negative, campaign_criterion.bid_modifier";
  const queries = [
    { label: "LANGUAGE", fields: "campaign_criterion.language.language_constant" },
    { label: "DEVICE", fields: "campaign_criterion.device.type" },
    { label: "AD_SCHEDULE", fields: "campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute" },
    { label: "AGE_RANGE", fields: "campaign_criterion.age_range.type" },
    { label: "GENDER", fields: "campaign_criterion.gender.type" },
    { label: "INCOME_RANGE", fields: "campaign_criterion.income_range.type" },
    { label: "PARENTAL_STATUS", fields: "campaign_criterion.parental_status.type" },
    { label: "USER_LIST", fields: "campaign_criterion.user_list.user_list" },
    { label: "AUDIENCE", fields: "campaign_criterion.audience.audience" },
    { label: "COMBINED_AUDIENCE", fields: "campaign_criterion.combined_audience.combined_audience" },
    { label: "CUSTOM_AUDIENCE", fields: "campaign_criterion.custom_audience.custom_audience" },
    { label: "TOPIC", fields: "campaign_criterion.topic.topic_constant" },
    { label: "PLACEMENT", fields: "campaign_criterion.placement.url" },
    { label: "YOUTUBE_VIDEO", fields: "campaign_criterion.youtube_video.video_id" },
    { label: "YOUTUBE_CHANNEL", fields: "campaign_criterion.youtube_channel.channel_id" },
    { label: "MOBILE_APP_CATEGORY", fields: "campaign_criterion.mobile_app_category.mobile_app_category_constant" },
    { label: "MOBILE_APPLICATION", fields: "campaign_criterion.mobile_application.app_id, campaign_criterion.mobile_application.name" },
    { label: "KEYWORD", fields: "campaign_criterion.keyword.text, campaign_criterion.keyword.match_type" },
  ];
  const rows: any[] = [];
  for (const q of queries) {
    try {
      rows.push(...await googleAdsSearchAll(apiBase, headers, `
        SELECT ${base}, ${q.fields}
        FROM campaign_criterion
        WHERE campaign_criterion.campaign = '${campaignResource}'
          AND campaign_criterion.type = ${q.label}
          AND campaign_criterion.status != 'REMOVED'
      `));
    } catch (e) {
      debug.partial_failures.push({ step: `read_campaign_criteria_${q.label}`, response: compactGoogleAdsError((e as any).response ?? String(e)) });
    }
  }
  return rows;
}

async function readAdGroupCriteria(apiBase: string, headers: Record<string, string>, sourceAdGroupResources: string, debug: any) {
  const query = `
    SELECT ad_group.id,
           ad_group_criterion.resource_name, ad_group_criterion.type, ad_group_criterion.status,
           ad_group_criterion.negative, ad_group_criterion.bid_modifier,
           ad_group_criterion.final_urls, ad_group_criterion.final_mobile_urls,
           ad_group_criterion.tracking_url_template, ad_group_criterion.final_url_suffix,
           ad_group_criterion.url_custom_parameters,
           ad_group_criterion.keyword.text,
           ad_group_criterion.keyword.match_type,
           ad_group_criterion.placement.url,
           ad_group_criterion.user_list.user_list,
           ad_group_criterion.audience.audience,
           ad_group_criterion.combined_audience.combined_audience,
           ad_group_criterion.custom_audience.custom_audience,
           ad_group_criterion.topic.topic_constant,
           ad_group_criterion.age_range.type,
           ad_group_criterion.gender.type,
           ad_group_criterion.income_range.type,
           ad_group_criterion.parental_status.type,
           ad_group_criterion.youtube_video.video_id,
           ad_group_criterion.youtube_channel.channel_id,
           ad_group_criterion.mobile_app_category.mobile_app_category_constant,
           ad_group_criterion.mobile_application.app_id,
           ad_group_criterion.mobile_application.name
    FROM ad_group_criterion
    WHERE ad_group_criterion.ad_group IN (${sourceAdGroupResources})
      AND ad_group_criterion.status != 'REMOVED'
  `;
  try {
    return await googleAdsSearchAll(apiBase, headers, query);
  } catch (e) {
    debug.partial_failures.push({ step: "read_ad_group_criteria", response: (e as any).response ?? String(e) });
    return [];
  }
}

async function readCampaignAssets(apiBase: string, headers: Record<string, string>, sourceCampaignResource: string, debug: any) {
  const query = `
    SELECT campaign_asset.asset, campaign_asset.field_type, campaign_asset.status
    FROM campaign_asset
    WHERE campaign_asset.campaign = '${sourceCampaignResource}'
      AND campaign_asset.status != 'REMOVED'
  `;
  try {
    return await googleAdsSearchAll(apiBase, headers, query);
  } catch (e) {
    debug.partial_failures.push({ step: "read_campaign_assets", response: (e as any).response ?? String(e) });
    return [];
  }
}

async function readAdGroupAssets(apiBase: string, headers: Record<string, string>, sourceAdGroupResources: string, debug: any) {
  const query = `
    SELECT ad_group.id, ad_group_asset.asset, ad_group_asset.field_type, ad_group_asset.status
    FROM ad_group_asset
    WHERE ad_group_asset.ad_group IN (${sourceAdGroupResources})
      AND ad_group_asset.status != 'REMOVED'
  `;
  try {
    return await googleAdsSearchAll(apiBase, headers, query);
  } catch (e) {
    debug.partial_failures.push({ step: "read_ad_group_assets", response: (e as any).response ?? String(e) });
    return [];
  }
}

function summarizeCampaignCriteria(rows: any[]) {
  const defaultDevices = ["DESKTOP", "MOBILE", "TABLET"];
  const languageConstants = rows
    .map((row: any) => row.campaignCriterion?.language?.languageConstant)
    .filter(Boolean)
    .sort();
  const deviceBidModifiers: Record<string, number> = {};
  for (const row of rows) {
    const cc = row.campaignCriterion;
    if (cc?.type !== "DEVICE" || !cc.device?.type) continue;
    const bidModifier = Number(cc.bidModifier);
    deviceBidModifiers[String(cc.device.type)] = Number.isFinite(bidModifier) ? bidModifier : 1;
  }
  const knownDevices = [...new Set([...defaultDevices, ...Object.keys(deviceBidModifiers)])].sort();
  const activeDevices = knownDevices.filter((device) => (deviceBidModifiers[device] ?? 1) > 0);
  return { languageConstants, activeDevices, deviceBidModifiers };
}

function compareCampaignCriteriaSummary(source: ReturnType<typeof summarizeCampaignCriteria>, cloned: ReturnType<typeof summarizeCampaignCriteria>) {
  const srcLang = source.languageConstants.join("|");
  const dstLang = cloned.languageConstants.join("|");
  if (srcLang !== dstLang) return { ok: false, reason: `idiomas origem=[${srcLang}] winner=[${dstLang}]` };
  if (cloned.languageConstants.length === 0) return { ok: false, reason: "winner ficou em Todos os idiomas" };
  const srcDev = stableRecordString(source.deviceBidModifiers);
  const dstDev = stableRecordString(cloned.deviceBidModifiers);
  if (srcDev !== dstDev) return { ok: false, reason: `dispositivos origem=${srcDev} winner=${dstDev}` };
  return { ok: true };
}

function stableRecordString(record: Record<string, number>) {
  return JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
}

function validateSourceLanguages(source: ReturnType<typeof summarizeCampaignCriteria>) {
  if (source.languageConstants.length === 0) {
    return { ok: false, reason: "Não encontrei LANGUAGE criteria na campanha original" };
  }
  return { ok: true };
}

async function validateClonedWinner(
  apiBase: string,
  headers: Record<string, string>,
  newCampaignResource: string,
  newCampaignId: string,
  sourceCriteriaSummary: ReturnType<typeof summarizeCampaignCriteria>,
  debug: any,
) {
  const campaignRows = await googleAdsSearchAll(apiBase, headers, `
    SELECT campaign.id, campaign.status, campaign.bidding_strategy_type,
           campaign.maximize_conversions.target_cpa_micros,
           campaign.campaign_budget, campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.id = ${newCampaignId}
  `).catch((e) => {
    throw new CloneError("validate_campaign", `validate campaign: ${extractError(e.response ?? e)}`, e.response ?? e);
  });
  const campaign = campaignRows[0]?.campaign ?? {};
  const criteriaSummary = summarizeCampaignCriteria(await readCampaignCriteria(apiBase, headers, newCampaignResource, newCampaignId, debug));
  const criteriaOk = compareCampaignCriteriaSummary(sourceCriteriaSummary, criteriaSummary);
  const adGroupRows = await googleAdsSearchAll(apiBase, headers, `
    SELECT ad_group.id
    FROM ad_group
    WHERE ad_group.campaign = '${newCampaignResource}'
      AND ad_group.status != 'REMOVED'
  `);
  const adGroupResources = adGroupRows.map((r: any) => `'customers/${newCampaignResource.split("/")[1]}/adGroups/${r.adGroup?.id}'`).join(",");
  const adRows = adGroupResources ? await googleAdsSearchAll(apiBase, headers, `
    SELECT ad_group_ad.ad.id
    FROM ad_group_ad
    WHERE ad_group_ad.ad_group IN (${adGroupResources})
      AND ad_group_ad.status != 'REMOVED'
  `) : [];

  const targetCpa = campaign?.maximizeConversions?.targetCpaMicros;
  const validation = {
    languages_applied: criteriaSummary.languageConstants,
    devices_applied: criteriaSummary.activeDevices,
    device_bid_modifiers_applied: criteriaSummary.deviceBidModifiers,
    bidding_type: campaign.biddingStrategyType,
    target_cpa_micros: targetCpa ?? null,
    status: campaign.status,
    budget_micros: Number(campaignRows[0]?.campaignBudget?.amountMicros ?? 0),
    ad_groups: adGroupRows.length,
    ads: adRows.length,
  };
  debug.post_create = validation;

  if (!criteriaOk.ok) return { ok: false, reason: criteriaOk.reason, ...validation };
  if (campaign.biddingStrategyType !== "MAXIMIZE_CONVERSIONS") return { ok: false, reason: `bidding veio ${campaign.biddingStrategyType}, esperado MAXIMIZE_CONVERSIONS`, ...validation };
  if (targetCpa !== undefined && targetCpa !== null && Number(targetCpa) > 0) return { ok: false, reason: `Maximize Conversions veio com target CPA (${targetCpa})`, ...validation };
  if (campaign.status !== "PAUSED") return { ok: false, reason: `status veio ${campaign.status}, esperado PAUSED`, ...validation };
  if (Number(campaignRows[0]?.campaignBudget?.amountMicros ?? 0) !== 30_000_000) return { ok: false, reason: "budget diferente de R$30/dia", ...validation };
  if (adGroupRows.length === 0) return { ok: false, reason: "winner ficou sem ad groups", ...validation };
  if (adRows.length === 0) return { ok: false, reason: "winner ficou sem anúncios", ...validation };
  return { ok: true, ...validation };
}

function buildCriterionOperation(scope: "campaign" | "adGroup", criterion: any, parentResource: string, opts: { skipGeo: boolean }) {
  if (!criterion) return null;
  const type = criterion.type;
  if (opts.skipGeo && ["LOCATION", "PROXIMITY"].includes(type)) return null;
  const create: any = scope === "campaign" ? { campaign: parentResource } : { adGroup: parentResource };
  if (criterion.status) create.status = criterion.status;
  if (typeof criterion.negative === "boolean") create.negative = criterion.negative;
  const bidModifier = Number(criterion.bidModifier);
  if (Number.isFinite(bidModifier) && bidModifier !== 1) create.bidModifier = bidModifier;
  if (criterion.finalUrls) create.finalUrls = criterion.finalUrls;
  if (criterion.finalMobileUrls) create.finalMobileUrls = criterion.finalMobileUrls;
  if (criterion.trackingUrlTemplate) create.trackingUrlTemplate = criterion.trackingUrlTemplate;
  if (criterion.finalUrlSuffix) create.finalUrlSuffix = criterion.finalUrlSuffix;
  if (criterion.urlCustomParameters) create.urlCustomParameters = criterion.urlCustomParameters;

  switch (type) {
    case "LANGUAGE":
      if (!criterion.language?.languageConstant) return null;
      create.language = { languageConstant: criterion.language.languageConstant };
      break;
    case "AD_SCHEDULE":
      if (!criterion.adSchedule) return null;
      create.adSchedule = cleanObject({
        dayOfWeek: criterion.adSchedule.dayOfWeek,
        startHour: criterion.adSchedule.startHour,
        startMinute: criterion.adSchedule.startMinute,
        endHour: criterion.adSchedule.endHour,
        endMinute: criterion.adSchedule.endMinute,
      });
      break;
    case "DEVICE":
      if (!criterion.device?.type) return null;
      create.device = { type: criterion.device.type };
      break;
    case "AGE_RANGE":
      if (!criterion.ageRange?.type) return null;
      create.ageRange = { type: criterion.ageRange.type };
      break;
    case "GENDER":
      if (!criterion.gender?.type) return null;
      create.gender = { type: criterion.gender.type };
      break;
    case "INCOME_RANGE":
      if (!criterion.incomeRange?.type) return null;
      create.incomeRange = { type: criterion.incomeRange.type };
      break;
    case "PARENTAL_STATUS":
      if (!criterion.parentalStatus?.type) return null;
      create.parentalStatus = { type: criterion.parentalStatus.type };
      break;
    case "KEYWORD":
      if (!criterion.keyword?.text || !criterion.keyword?.matchType) return null;
      create.keyword = { text: criterion.keyword.text, matchType: criterion.keyword.matchType };
      break;
    case "PLACEMENT":
      if (!criterion.placement?.url) return null;
      create.placement = { url: criterion.placement.url };
      break;
    case "USER_LIST":
      if (!criterion.userList?.userList) return null;
      create.userList = { userList: criterion.userList.userList };
      break;
    case "AUDIENCE":
      if (!criterion.audience?.audience) return null;
      create.audience = { audience: criterion.audience.audience };
      break;
    case "COMBINED_AUDIENCE":
      if (!criterion.combinedAudience?.combinedAudience) return null;
      create.combinedAudience = { combinedAudience: criterion.combinedAudience.combinedAudience };
      break;
    case "CUSTOM_AUDIENCE":
      if (!criterion.customAudience?.customAudience) return null;
      create.customAudience = { customAudience: criterion.customAudience.customAudience };
      break;
    case "TOPIC":
      if (!criterion.topic?.topicConstant) return null;
      create.topic = { topicConstant: criterion.topic.topicConstant };
      break;
    case "YOUTUBE_VIDEO":
      if (!criterion.youtubeVideo?.videoId) return null;
      create.youtubeVideo = { videoId: criterion.youtubeVideo.videoId };
      break;
    case "YOUTUBE_CHANNEL":
      if (!criterion.youtubeChannel?.channelId) return null;
      create.youtubeChannel = { channelId: criterion.youtubeChannel.channelId };
      break;
    case "MOBILE_APP_CATEGORY":
      if (!criterion.mobileAppCategory?.mobileAppCategoryConstant) return null;
      create.mobileAppCategory = { mobileAppCategoryConstant: criterion.mobileAppCategory.mobileAppCategoryConstant };
      break;
    case "MOBILE_APPLICATION":
      if (!criterion.mobileApplication?.appId) return null;
      create.mobileApplication = cleanObject({ appId: criterion.mobileApplication.appId, name: criterion.mobileApplication.name });
      break;
    default:
      return null;
  }

  return { create: cleanObject(create) };
}

function buildWinnerBidding(sourceType: string) {
  return {
    createFields: { maximizeConversions: {} },
    debug: {
      source_type: sourceType,
      applied: "MAXIMIZE_CONVERSIONS",
      target_cpa_micros: null,
      copied_as: "maximizeConversions_without_target_cpa",
    },
  };
}

function buildAdCreate(ad: any, assetRefs: Set<string>) {
  const create: any = cleanObject({
    name: ad.name,
    finalUrls: ad.finalUrls,
    finalMobileUrls: ad.finalMobileUrls,
    trackingUrlTemplate: ad.trackingUrlTemplate,
    finalUrlSuffix: ad.finalUrlSuffix,
    urlCustomParameters: ad.urlCustomParameters,
  });

  if (ad.responsiveDisplayAd) {
    const rda = ad.responsiveDisplayAd;
    const responsiveDisplayAd = cleanObject({
      headlines: copyTextAssets(rda.headlines),
      longHeadline: copyTextAsset(rda.longHeadline),
      descriptions: copyTextAssets(rda.descriptions),
      businessName: rda.businessName,
      marketingImages: copyAdImageAssets(rda.marketingImages, assetRefs),
      squareMarketingImages: copyAdImageAssets(rda.squareMarketingImages, assetRefs),
      logoImages: copyAdImageAssets(rda.logoImages, assetRefs),
      squareLogoImages: copyAdImageAssets(rda.squareLogoImages, assetRefs),
      youtubeVideos: copyAdVideoAssets(rda.youtubeVideos, assetRefs),
      callToActionText: rda.callToActionText,
      allowFlexibleColor: rda.allowFlexibleColor,
      accentColor: rda.accentColor,
      mainColor: rda.mainColor,
      formatSetting: rda.formatSetting,
    });
    create.responsiveDisplayAd = responsiveDisplayAd;
    return create;
  }

  if (ad.responsiveSearchAd) {
    const rsa = ad.responsiveSearchAd;
    create.responsiveSearchAd = cleanObject({
      headlines: copyTextAssets(rsa.headlines),
      descriptions: copyTextAssets(rsa.descriptions),
      path1: rsa.path1,
      path2: rsa.path2,
    });
    return create;
  }

  if (ad.displayUploadAd) {
    const dua = ad.displayUploadAd;
    create.displayUploadAd = cleanObject({
      mediaBundle: dua.mediaBundle ? cleanObject({ asset: dua.mediaBundle.asset }) : undefined,
      displayUploadProductType: dua.displayUploadProductType,
    });
    if (dua.mediaBundle?.asset) assetRefs.add(dua.mediaBundle.asset);
    return create;
  }

  return null;
}

function copyTextAssets(items: any[] | undefined) {
  return (items ?? []).map(copyTextAsset).filter(Boolean);
}

function copyTextAsset(item: any) {
  if (!item?.text) return null;
  return cleanObject({ text: item.text, pinnedField: item.pinnedField });
}

function copyAdImageAssets(items: any[] | undefined, assetRefs: Set<string>) {
  return (items ?? []).map((item: any) => {
    const asset = item?.asset;
    if (!asset) return null;
    assetRefs.add(asset);
    return { asset };
  }).filter(Boolean);
}

function copyAdVideoAssets(items: any[] | undefined, assetRefs: Set<string>) {
  return (items ?? []).map((item: any) => {
    const asset = item?.asset;
    if (!asset) return null;
    assetRefs.add(asset);
    return { asset };
  }).filter(Boolean);
}

function cleanObject<T extends Record<string, any>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) delete obj[key];
  }
  return obj;
}

function extractError(j: any): string {
  return j?.error?.details?.[0]?.errors?.[0]?.message ?? j?.error?.message ?? JSON.stringify(j);
}

function compactGoogleAdsError(j: any) {
  if (!Array.isArray(j)) return j;
  return j.map((item: any) => ({
    code: item?.error?.code,
    status: item?.error?.status,
    message: item?.error?.message,
    requestId: item?.error?.details?.[0]?.requestId,
    errors: item?.error?.details?.[0]?.errors,
  }));
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
