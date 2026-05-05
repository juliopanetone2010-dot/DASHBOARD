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
      let expandedQuery = admin
        .from("campaign_expansion_logs")
        .select("original_campaign_id, country_code, action")
        .eq("user_id", userId)
        .in("action", ["created", "suggested"]);
      expandedQuery = siteId ? expandedQuery.eq("site_id", siteId) : expandedQuery.is("site_id", null);
      const { data } = await expandedQuery;
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

    // Receita por (camp, date), em USD bruto. Para site específico, usa a receita atribuída ao site.
    // A conversão para BRL e o revshare são aplicados uma única vez na distribuição por país.
    type DailyRow = { campaign_id: string; date: string; revenue: number };
    const dailyRows: DailyRow[] = [];
    const siteShareByCD = new Map<string, number>();
    const siteRevenueCampaignIds = new Set<string>();
    for (const chunk of chunkArr(campIds, 200)) {
      if (siteId) {
        const selectedRev = new Map<string, number>();
        const totalRev = new Map<string, number>();
        let start = 0;
        for (;;) {
          const { data, error } = await admin
            .from("gam_campaign_source_revenue")
            .select("campaign_id, date, site_id, revenue_usd")
            .eq("user_id", userId)
            .in("campaign_id", chunk)
            .gte("date", from)
            .lte("date", to)
            .range(start, start + 999);
          if (error) return json({ error: error.message });
          const rows = data ?? [];
          for (const r of rows) {
            const k = `${String(r.campaign_id)}|${String(r.date)}`;
            const v = Number(r.revenue_usd) || 0;
            totalRev.set(k, (totalRev.get(k) ?? 0) + v);
            if (String(r.site_id ?? "") === siteId) selectedRev.set(k, (selectedRev.get(k) ?? 0) + v);
          }
          if (rows.length < 1000) break;
          start += 1000;
        }
        for (const [k, revenue] of selectedRev) {
          const [campaign_id, date] = k.split("|");
          if (revenue <= 0) continue;
          dailyRows.push({ campaign_id, date, revenue });
          siteRevenueCampaignIds.add(campaign_id);
          const total = totalRev.get(k) ?? revenue;
          siteShareByCD.set(k, total > 0 ? Math.min(1, Math.max(0, revenue / total)) : 1);
        }
      } else {
        const { data, error } = await admin
          .from("daily_metrics")
          .select("campaign_id, date, revenue, spend, profit")
          .eq("user_id", userId)
          .in("campaign_id", chunk)
          .gte("date", from)
          .lte("date", to)
          .limit(50000);
        if (error) return json({ error: error.message });
        for (const r of data ?? []) {
          const revenueUsd = Number(r.revenue) || (((Number(r.spend) || 0) + (Number(r.profit) || 0)) / fxUsdBrl);
          dailyRows.push({ campaign_id: String(r.campaign_id), date: String(r.date), revenue: revenueUsd });
        }
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
      const cd = `${r.campaign_id}|${r.date}`;
      const siteFactor = siteId ? (siteShareByCD.get(cd) ?? 0) : 1;
      if (siteFactor <= 0) continue;
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
      c.cost_brl += (r.cost || 0) * siteFactor;
      c.clicks += (r.clicks || 0) * siteFactor;
      c.impressions += (r.impressions || 0) * siteFactor;
      if (!c.country_criterion_id && r.country_criterion_id) c.country_criterion_id = r.country_criterion_id;
      if (!c.google_account_id && r.google_account_id) c.google_account_id = r.google_account_id;

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
  startStatus: "PAUSED" | "ENABLED" = "PAUSED",
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
      status: startStatus.toLowerCase(),
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
      winner_started_at: startStatus === "ENABLED" ? new Date().toISOString() : null,
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

async function readCampaignCriteria(apiBase: string, headers: Record<string, string>, _campaignResource: string, campaignId: string, debug: any) {
  const query = `
    SELECT campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.status,
           campaign_criterion.negative, campaign_criterion.bid_modifier,
           campaign_criterion.language.language_constant,
           campaign_criterion.ad_schedule.day_of_week,
           campaign_criterion.ad_schedule.start_hour,
           campaign_criterion.ad_schedule.start_minute,
           campaign_criterion.ad_schedule.end_hour,
           campaign_criterion.ad_schedule.end_minute,
           campaign_criterion.device.type,
           campaign_criterion.age_range.type,
           campaign_criterion.gender.type,
           campaign_criterion.income_range.type,
           campaign_criterion.parental_status.type,
           campaign_criterion.user_list.user_list,
           campaign_criterion.audience.audience,
           campaign_criterion.combined_audience.combined_audience,
           campaign_criterion.custom_audience.custom_audience,
           campaign_criterion.topic.topic_constant,
           campaign_criterion.placement.url,
           campaign_criterion.youtube_video.video_id,
           campaign_criterion.youtube_channel.channel_id,
           campaign_criterion.mobile_app_category.mobile_app_category_constant,
           campaign_criterion.mobile_application.app_id,
           campaign_criterion.mobile_application.name,
           campaign_criterion.keyword.text,
           campaign_criterion.keyword.match_type
    FROM campaign_criterion
    WHERE campaign.id = ${campaignId}
      AND campaign_criterion.status != 'REMOVED'
  `;
  try {
    return await googleAdsSearchAll(apiBase, headers, query);
  } catch (e) {
    debug.partial_failures.push({ step: "read_campaign_criteria", response: (e as any).response ?? String(e) });
    return [];
  }
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
  const defaultDevices = ["COMPUTER", "MOBILE", "TABLET"];
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
  const srcDev = JSON.stringify(source.deviceBidModifiers);
  const dstDev = JSON.stringify(cloned.deviceBidModifiers);
  if (srcDev !== dstDev) return { ok: false, reason: `dispositivos origem=${srcDev} winner=${dstDev}` };
  return { ok: true };
}

function validateSourceLanguages(source: ReturnType<typeof summarizeCampaignCriteria>) {
  if (source.languageConstants.length === 0) {
    return { ok: false, reason: "Não encontrei LANGUAGE criteria na campanha original" };
  }
  return { ok: true };
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

function buildCampaignBidding(campaign: any) {
  const type = campaign.biddingStrategyType;
  const createFields: any = {};
  const debug: any = { type, portfolio_strategy: campaign.biddingStrategy ?? null };

  if (campaign.biddingStrategy) {
    createFields.biddingStrategy = campaign.biddingStrategy;
    return { createFields, debug: { ...debug, copied_as: "portfolio_strategy" } };
  }

  switch (type) {
    case "MANUAL_CPC":
      createFields.manualCpc = cleanObject({ enhancedCpcEnabled: campaign.manualCpc?.enhancedCpcEnabled });
      break;
    case "MAXIMIZE_CONVERSIONS":
      createFields.maximizeConversions = cleanObject({ targetCpaMicros: campaign.maximizeConversions?.targetCpaMicros });
      break;
    case "MAXIMIZE_CONVERSION_VALUE":
      createFields.maximizeConversionValue = cleanObject({ targetRoas: campaign.maximizeConversionValue?.targetRoas });
      break;
    case "TARGET_CPA":
      createFields.targetCpa = cleanObject({ targetCpaMicros: campaign.targetCpa?.targetCpaMicros });
      break;
    case "TARGET_ROAS":
      createFields.targetRoas = cleanObject({ targetRoas: campaign.targetRoas?.targetRoas });
      break;
    case "TARGET_SPEND":
      createFields.targetSpend = cleanObject({
        targetSpendMicros: campaign.targetSpend?.targetSpendMicros,
        cpcBidCeilingMicros: campaign.targetSpend?.cpcBidCeilingMicros,
      });
      break;
    case "TARGET_IMPRESSION_SHARE":
      createFields.targetImpressionShare = cleanObject({
        location: campaign.targetImpressionShare?.location,
        locationFractionMicros: campaign.targetImpressionShare?.locationFractionMicros,
        cpcBidCeilingMicros: campaign.targetImpressionShare?.cpcBidCeilingMicros,
      });
      break;
    default:
      createFields.maximizeConversions = {};
      debug.fallback = "maximize_conversions";
      break;
  }

  return { createFields, debug: { ...debug, copied_as: Object.keys(createFields)[0] } };
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
