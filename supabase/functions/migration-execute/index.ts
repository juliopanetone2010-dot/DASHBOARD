// Migra (duplica) uma campanha DISPLAY de uma conta Google Ads para OUTRA,
// trocando a Final URL manualmente. Suporta cross-account (re-uploads de imagens).
// Nova campanha entra PAUSED no Funil Inteligente (não na automação principal).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface MigrationBody {
  source_campaign_id: string;
  source_google_account_id: string;
  destination_google_account_id: string;
  destination_site_id: string;
  final_url: string;
  tracking_template?: string;
  final_url_suffix?: string;
  name_suffix?: string;
  initial_budget?: number; // BRL/day, default vem do site_funnel_config (fallback 30)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "unauthorized" }, 401);
    const userId = u.user.id;

    const body = (await req.json()) as MigrationBody;
    if (!body?.source_campaign_id || !body?.source_google_account_id ||
        !body?.destination_google_account_id || !body?.destination_site_id ||
        !body?.final_url) {
      return json({ error: "campos obrigatórios: source_campaign_id, source_google_account_id, destination_google_account_id, destination_site_id, final_url" }, 400);
    }
    try { new URL(body.final_url); } catch { return json({ error: "final_url inválida" }, 400); }

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Carrega contas
    const [{ data: srcAcc }, { data: dstAcc }, { data: dstSite }, { data: srcCamp }] = await Promise.all([
      admin.from("google_accounts")
        .select("id, customer_id, refresh_token, login_customer_id")
        .eq("id", body.source_google_account_id).eq("user_id", userId).maybeSingle(),
      admin.from("google_accounts")
        .select("id, customer_id, refresh_token, login_customer_id")
        .eq("id", body.destination_google_account_id).eq("user_id", userId).maybeSingle(),
      admin.from("sites").select("id, name, domain").eq("id", body.destination_site_id).eq("user_id", userId).maybeSingle(),
      admin.from("campaigns").select("campaign_id, name, channel_type, google_account_id")
        .eq("user_id", userId).eq("campaign_id", body.source_campaign_id).maybeSingle(),
    ]);

    if (!srcAcc?.refresh_token) return json({ error: "Conta origem sem refresh_token" }, 400);
    if (!dstAcc?.refresh_token) return json({ error: "Conta destino sem refresh_token" }, 400);
    if (!dstSite) return json({ error: "Site destino não encontrado" }, 404);
    if (!srcCamp) return json({ error: "Campanha origem não encontrada no banco" }, 404);
    if (srcCamp.channel_type && srcCamp.channel_type !== "DISPLAY") {
      return json({ error: `v1 suporta apenas DISPLAY (origem: ${srcCamp.channel_type})` }, 400);
    }

    const crossAccount = srcAcc.customer_id !== dstAcc.customer_id;

    // Orçamento inicial
    let initialBudget = Number(body.initial_budget) || 0;
    if (initialBudget <= 0) {
      const { data: funnelCfg } = await admin
        .from("site_funnel_config")
        .select("initial_budget")
        .eq("user_id", userId).eq("site_id", body.destination_site_id).maybeSingle();
      initialBudget = Number(funnelCfg?.initial_budget) || 30;
    }

    // Cria registro de migração (pending)
    const { data: migRow, error: migErr } = await admin
      .from("campaign_migrations")
      .insert({
        user_id: userId,
        source_google_account_id: body.source_google_account_id,
        source_campaign_id: body.source_campaign_id,
        source_campaign_name: srcCamp.name,
        destination_site_id: body.destination_site_id,
        destination_google_account_id: body.destination_google_account_id,
        destination_domain: dstSite.domain,
        final_url: body.final_url,
        tracking_template: body.tracking_template || null,
        final_url_suffix: body.final_url_suffix || null,
        name_suffix: body.name_suffix || "[MIG]",
        initial_budget: initialBudget,
        status: "running",
        payload: { request: body, cross_account: crossAccount },
      })
      .select("id")
      .single();
    if (migErr || !migRow) return json({ error: `falha registrando migration: ${migErr?.message}` }, 500);
    const migrationId = migRow.id;

    try {
      const result = await runMigration({
        admin, userId,
        migrationId,
        srcAcc, dstAcc, srcCamp,
        dstSiteId: body.destination_site_id,
        finalUrl: body.final_url,
        trackingTemplate: body.tracking_template,
        finalUrlSuffix: body.final_url_suffix,
        nameSuffix: body.name_suffix || "[MIG]",
        initialBudget,
        crossAccount,
      });

      await admin.from("campaign_migrations").update({
        status: result.ok ? "success" : result.partial ? "partial" : "failed",
        executed_at: new Date().toISOString(),
        destination_campaign_id: result.new_campaign_id || null,
        error: result.error || null,
        result,
      }).eq("id", migrationId);

      return json({ migration_id: migrationId, ...result });
    } catch (e) {
      const msg = String((e as Error).message || e);
      await admin.from("campaign_migrations").update({
        status: "failed", executed_at: new Date().toISOString(), error: msg,
      }).eq("id", migrationId);
      return json({ migration_id: migrationId, ok: false, error: msg }, 500);
    }
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});

// =============== CORE ===============

interface RunArgs {
  admin: any; userId: string; migrationId: string;
  srcAcc: any; dstAcc: any; srcCamp: any;
  dstSiteId: string;
  finalUrl: string; trackingTemplate?: string; finalUrlSuffix?: string;
  nameSuffix: string; initialBudget: number; crossAccount: boolean;
}

async function runMigration(a: RunArgs) {
  const { admin, userId, srcAcc, dstAcc, srcCamp } = a;

  const srcToken = await getAccessToken(srcAcc.refresh_token);
  const dstToken = a.crossAccount ? await getAccessToken(dstAcc.refresh_token) : srcToken;

  const srcHeaders = buildHeaders(srcToken, srcAcc.login_customer_id);
  const dstHeaders = buildHeaders(dstToken, dstAcc.login_customer_id);
  const srcBase = `https://googleads.googleapis.com/v21/customers/${srcAcc.customer_id}`;
  const dstBase = `https://googleads.googleapis.com/v21/customers/${dstAcc.customer_id}`;

  const srcCampResource = `customers/${srcAcc.customer_id}/campaigns/${srcCamp.campaign_id}`;
  const debug: any = {
    source: {},
    cloned: {},
    skipped: {},
    steps: {
      campaign_created: false,
      ad_groups_created: false,
      assets_reuploaded: false,
      ads_created: false,
    },
    partial_failures: [],
    cross_account: a.crossAccount,
  };

  // 1) Lê config da campanha origem
  const cRows = await searchAll(srcBase, srcHeaders, `
    SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
           campaign.advertising_channel_sub_type,
           campaign.bidding_strategy_type,
           campaign.contains_eu_political_advertising,
           campaign.network_settings.target_google_search,
           campaign.network_settings.target_search_network,
           campaign.network_settings.target_content_network,
           campaign.network_settings.target_partner_search_network,
           campaign.geo_target_type_setting.positive_geo_target_type,
           campaign.geo_target_type_setting.negative_geo_target_type,
           campaign_budget.delivery_method
    FROM campaign
    WHERE campaign.id = ${srcCamp.campaign_id}
  `);
  const cRow = cRows[0];
  if (!cRow) return { ok: false, error: "Campanha não encontrada no Google Ads (origem)" };

  const channelType = cRow.campaign?.advertisingChannelType ?? "DISPLAY";
  if (channelType !== "DISPLAY") return { ok: false, error: `v1 só DISPLAY (Google retornou ${channelType})` };

  const euPolitical = cRow.campaign?.containsEuPoliticalAdvertising === "CONTAINS_EU_POLITICAL_ADVERTISING"
    ? "CONTAINS_EU_POLITICAL_ADVERTISING" : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";
  const sourceNetwork = cRow.campaign?.networkSettings ?? {};
  const sourceGeoSetting = cRow.campaign?.geoTargetTypeSetting;

  // Ad groups
  const agRows = await searchAll(srcBase, srcHeaders, `
    SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type
    FROM ad_group
    WHERE ad_group.campaign = '${srcCampResource}' AND ad_group.status != 'REMOVED'
  `);
  if (agRows.length === 0) return { ok: false, error: "Origem sem ad groups ativos" };
  debug.source.ad_groups = agRows.length;

  const srcAgIds = agRows.map((r: any) => String(r.adGroup?.id)).filter(Boolean);
  const srcAgRefs = srcAgIds.map((id: string) => `'customers/${srcAcc.customer_id}/adGroups/${id}'`).join(",");

  // Ads
  const adRows = await searchAll(srcBase, srcHeaders, `
    SELECT ad_group.id, ad_group_ad.status,
           ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name,
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
           ad_group_ad.ad.display_upload_ad.media_bundle,
           ad_group_ad.ad.display_upload_ad.display_upload_product_type,
           ad_group_ad.ad.image_ad.image_asset,
           ad_group_ad.ad.image_ad.name,
           ad_group_ad.ad.image_ad.mime_type,
           ad_group_ad.ad.image_ad.pixel_width,
           ad_group_ad.ad.image_ad.pixel_height
    FROM ad_group_ad
    WHERE ad_group_ad.ad_group IN (${srcAgRefs}) AND ad_group_ad.status != 'REMOVED'
  `);
  if (adRows.length === 0) return { ok: false, error: "Origem sem anúncios ativos" };
  debug.source.ads = adRows.length;

  // Campaign criteria (geo, language, device, audiences, etc) — para migração COPIAMOS geo
  const campCriteriaRows = await readCampaignCriteria(srcBase, srcHeaders, srcCampResource, debug);
  debug.source.campaign_criteria = campCriteriaRows.length;

  // Ad group criteria (placements, keywords, audiences, ages...)
  const agCriteriaRows = await readAdGroupCriteria(srcBase, srcHeaders, srcAgRefs, debug);
  debug.source.ad_group_criteria = agCriteriaRows.length;

  // Coleta TODOS os asset resource names referenciados em ads (imagens/videos).
  // O re-upload acontece só depois de campanha/ad groups criados para permitir modo safe parcial.
  const assetRefs = new Set<string>();
  for (const r of adRows) {
    const ad = r.adGroupAd?.ad;
    const rda = ad?.responsiveDisplayAd;
    if (rda) {
      for (const list of [rda.marketingImages, rda.squareMarketingImages, rda.logoImages, rda.squareLogoImages, rda.youtubeVideos]) {
        for (const it of list ?? []) if (it?.asset) assetRefs.add(it.asset);
      }
    }
    const dua = ad?.displayUploadAd;
    if (dua?.mediaBundle?.asset) assetRefs.add(dua.mediaBundle.asset);
  }
  debug.source.assets = assetRefs.size;

  // ===== Cria budget na conta destino =====
  const seed = Date.now();
  // Inclui seed no nome para evitar DUPLICATE_CAMPAIGN_NAME ao migrar a mesma campanha mais de uma vez
  const stamp = new Date(seed).toISOString().slice(5, 16).replace(/[-T:]/g, "");
  const baseName = `${srcCamp.name} ${a.nameSuffix}`.slice(0, 230);
  let newName = `${baseName} ${stamp}`.slice(0, 250);
  const newBudgetMicros = Math.round(a.initialBudget * 1_000_000);
  let newCampResource = "";
  let newCampId = "";

  try {
    const budgetRes = await mutate(dstBase, dstHeaders, "campaignBudgets", [{
      create: {
        name: `${newName} budget ${seed}`,
        amountMicros: String(newBudgetMicros),
        deliveryMethod: cRow.campaignBudget?.deliveryMethod ?? "STANDARD",
        explicitlyShared: false,
      },
    }], "budget_create");
    if (!budgetRes.results[0]?.resourceName) {
      return { ok: false, error: `budget create falhou: ${extractError(budgetRes.partialFailureError)}`, debug };
    }
    const newBudgetResource = budgetRes.results[0].resourceName;

    // ===== Cria campanha =====
    const today = new Date();
    const startDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    const networkSettings = {
      targetGoogleSearch: sourceNetwork.targetGoogleSearch ?? false,
      targetSearchNetwork: sourceNetwork.targetSearchNetwork ?? false,
      targetContentNetwork: sourceNetwork.targetContentNetwork ?? true,
      targetPartnerSearchNetwork: sourceNetwork.targetPartnerSearchNetwork ?? false,
    };
    const campCreate: any = {
      name: newName,
      status: "PAUSED",
      advertisingChannelType: channelType,
      campaignBudget: newBudgetResource,
      containsEuPoliticalAdvertising: euPolitical,
      networkSettings,
      startDate,
      maximizeConversions: {},
    };
    if (a.trackingTemplate) campCreate.trackingUrlTemplate = a.trackingTemplate;
    // UTM padrão SEMPRE aplicado a nível de campanha (sobrescreve o input se vier)
    const DEFAULT_UTM_SUFFIX = "utm_source=google&utm_campaign={campaignid}&utm_adgroup={adgroupid}&utm_content={creative}&utm_placement={campaignid}_{placement}";
    campCreate.finalUrlSuffix = a.finalUrlSuffix && a.finalUrlSuffix.trim().length > 0 ? a.finalUrlSuffix : DEFAULT_UTM_SUFFIX;
    if (sourceGeoSetting) {
      campCreate.geoTargetTypeSetting = {
        positiveGeoTargetType: sourceGeoSetting.positiveGeoTargetType ?? "PRESENCE_OR_INTEREST",
        negativeGeoTargetType: sourceGeoSetting.negativeGeoTargetType ?? "PRESENCE",
      };
    }
    let campRes = await mutate(dstBase, dstHeaders, "campaigns", [{ create: campCreate }], "campaign_create", [{ campaign_name: newName }]);
    // Retry com sufixo aleatório se o nome já existir na conta destino
    if (!campRes.results[0]?.resourceName && /DUPLICATE_CAMPAIGN_NAME/i.test(JSON.stringify(campRes.partialFailureError ?? ""))) {
      const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
      newName = `${baseName} ${stamp}-${rand}`.slice(0, 250);
      campCreate.name = newName;
      campRes = await mutate(dstBase, dstHeaders, "campaigns", [{ create: campCreate }], "campaign_create_retry", [{ campaign_name: newName }]);
    }
    newCampResource = campRes.results[0]?.resourceName ?? "";
    newCampId = newCampResource.split("/").pop() ?? "";
    if (!newCampResource) return { ok: false, error: `campaign create: ${extractError(campRes.partialFailureError)}`, debug, payload: campCreate };
    debug.steps.campaign_created = true;

    // ===== Campaign criteria (geo, language, device, audiences se mesma conta) =====
    const campCritOps: any[] = [];
    for (const row of campCriteriaRows) {
      const cc = row.campaignCriterion;
      const op = buildCriterionOp("campaign", cc, newCampResource, { skipAudiences: a.crossAccount });
      if (op) campCritOps.push(op);
      else debug.skipped[`camp_crit_${cc?.type ?? "UNK"}`] = (debug.skipped[`camp_crit_${cc?.type ?? "UNK"}`] ?? 0) + 1;
    }
    const ccr = await mutate(dstBase, dstHeaders, "campaignCriteria", campCritOps, "camp_crits");
    debug.cloned.campaign_criteria = ccr.created;

    // ===== Ad groups =====
    const oldToNewAg = new Map<string, string>();
    const agOps = agRows.map((row: any) => ({
      create: clean({
        name: row.adGroup.name,
        campaign: newCampResource,
        status: row.adGroup.status ?? "ENABLED",
        type: row.adGroup.type ?? "DISPLAY_STANDARD",
      }),
    }));
    const agContexts = agRows.map((row: any) => ({ source_ad_group_id: String(row.adGroup?.id), ad_group_name: row.adGroup?.name }));
    const agRes = await mutate(dstBase, dstHeaders, "adGroups", agOps, "ad_groups", agContexts);
    if (agRes.errors?.length) debug.partial_failures.push({ step: "ad_groups", errors: agRes.errors });
    agRows.forEach((row: any, i: number) => {
      const rn = agRes.results[i]?.resourceName;
      if (rn) oldToNewAg.set(String(row.adGroup.id), rn);
    });
    debug.cloned.ad_groups = oldToNewAg.size;
    if (oldToNewAg.size === 0) {
      await removeCampaign(dstBase, dstHeaders, newCampResource);
      return { ok: false, error: `ad groups falharam: ${extractError(agRes.partialFailureError)}`, debug };
    }
    debug.steps.ad_groups_created = true;

    // ===== Ad group criteria =====
    const agCritOps: any[] = [];
    for (const row of agCriteriaRows) {
      const newAg = oldToNewAg.get(String(row.adGroup?.id));
      if (!newAg) continue;
      const op = buildCriterionOp("adGroup", row.adGroupCriterion, newAg, { skipAudiences: a.crossAccount });
      if (op) agCritOps.push(op);
      else debug.skipped[`ag_crit_${row.adGroupCriterion?.type ?? "UNK"}`] = (debug.skipped[`ag_crit_${row.adGroupCriterion?.type ?? "UNK"}`] ?? 0) + 1;
    }
    const agCritRes = await mutate(dstBase, dstHeaders, "adGroupCriteria", agCritOps, "ag_crits");
    debug.cloned.ad_group_criteria = agCritRes.created;

    // ===== Assets: no cross-account, só re-upload DEPOIS que campanha/ad groups existem.
    // Se falhar, fica em modo safe: mantém campanha + ad groups e registra parcial.
    const assetMap = new Map<string, string>();
    if (a.crossAccount && assetRefs.size > 0) {
      const reupResult = await reuploadAssets(srcBase, srcHeaders, dstBase, dstHeaders, dstAcc.customer_id, [...assetRefs]);
      for (const [k, v] of reupResult.map.entries()) assetMap.set(k, v);
      debug.cloned.assets_reuploaded = assetMap.size;
      debug.skipped.assets = reupResult.skipped;
      debug.asset_errors = reupResult.errors;
      debug.steps.assets_reuploaded = assetMap.size > 0 && reupResult.errors.length === 0;
      if (reupResult.errors.length > 0) debug.partial_failures.push({ step: "assets", errors: reupResult.errors });
    }

    const registerLocalPartial = async (stage: string) => {
      await persistLocalCampaignAndFunnel(admin, {
        userId,
        dstSiteId: a.dstSiteId,
        dstGoogleAccountId: a.dstAcc.id,
        campaignId: newCampId,
        campaignName: newName,
        budgetMicros: newBudgetMicros,
        initialBudget: a.initialBudget,
      });
      return {
        ok: false,
        partial: true,
        stage,
        new_campaign_id: newCampId,
        new_campaign_name: newName,
        destination_customer_id: dstAcc.customer_id,
        ad_groups_cloned: oldToNewAg.size,
        ads_cloned: 0,
        assets_reuploaded: a.crossAccount ? assetMap.size : 0,
        campaign_criteria_cloned: ccr.created,
        ad_group_criteria_cloned: agCritRes.created,
        debug,
      };
    };

    if (a.crossAccount && assetRefs.size > 0 && assetMap.size === 0) {
      const partial = await registerLocalPartial("assets_failed");
      return { ...partial, error: "assets falharam: nenhum asset foi recriado na conta destino" };
    }

    // ===== Ads — com final_urls SOBRESCRITA =====
    const adOps: any[] = [];
    const adContexts: any[] = [];
    let adsSkipped = 0;
    for (const row of adRows) {
      const newAg = oldToNewAg.get(String(row.adGroup?.id));
      if (!newAg) { adsSkipped++; continue; }
      const ad = row.adGroupAd?.ad ?? {};
      const built = buildAd(ad, assetMap, a.crossAccount, debug, row.adGroup?.id);
      if (!built) { adsSkipped++; debug.skipped[`ad_${ad.type ?? "UNK"}`] = (debug.skipped[`ad_${ad.type ?? "UNK"}`] ?? 0) + 1; continue; }
      // Override final URL
      built.finalUrls = [a.finalUrl];
      delete built.finalMobileUrls;
      adOps.push({
        create: { adGroup: newAg, status: row.adGroupAd?.status ?? "ENABLED", ad: built },
      });
      adContexts.push({ source_ad_group_id: String(row.adGroup?.id), source_ad_id: String(ad.id ?? ""), ad_name: ad.name ?? null });
    }
    // Se não havia NENHUM ad enviado (todos pulados por tipo não suportado), nem chamamos a API
    let adsRes: any = { created: 0, errors: [], partialFailureError: null };
    if (adOps.length > 0) {
      adsRes = await mutate(dstBase, dstHeaders, "adGroupAds", adOps, "ads", adContexts);
    }
    debug.cloned.ads = adsRes.created;
    debug.skipped.ads = adsSkipped;
    if (adsRes.errors?.length) debug.partial_failures.push({ step: "ads", errors: adsRes.errors });
    if (adsRes.created === 0) {
      const partial = await registerLocalPartial("ads_failed");
      const skippedTypes = Object.entries(debug.skipped)
        .filter(([k]) => k.startsWith("ad_"))
        .map(([k, v]) => `${k.replace("ad_", "")}=${v}`)
        .join(", ");
      const apiErr = extractError(adsRes.partialFailureError);
      const reason = adOps.length === 0
        ? `nenhum ad foi enviado — tipos: ${skippedTypes || "0"}. RDA é replicado automaticamente; HTML5 (display upload) precisa ter o ZIP re-uploadado manualmente no ad group novo (a API do Google Ads não expõe os bytes do bundle).`
        : `ads falharam: ${apiErr || "sem detalhe da API"}`;
      return { ...partial, error: reason };
    }
    debug.steps.ads_created = true;

    // ===== Persistência local =====
    await persistLocalCampaignAndFunnel(admin, {
      userId,
      dstSiteId: a.dstSiteId,
      dstGoogleAccountId: a.dstAcc.id,
      campaignId: newCampId,
      campaignName: newName,
      budgetMicros: newBudgetMicros,
      initialBudget: a.initialBudget,
    });

    const hasPartialErrors = (adsRes.errors?.length ?? 0) > 0 || (debug.asset_errors?.length ?? 0) > 0;
    return {
      ok: !hasPartialErrors,
      partial: hasPartialErrors,
      error: hasPartialErrors ? "migração parcial: alguns assets/ads falharam" : null,
      new_campaign_id: newCampId,
      new_campaign_name: newName,
      destination_customer_id: dstAcc.customer_id,
      ad_groups_cloned: oldToNewAg.size,
      ads_cloned: adsRes.created,
      assets_reuploaded: a.crossAccount ? assetMap.size : 0,
      campaign_criteria_cloned: ccr.created,
      ad_group_criteria_cloned: agCritRes.created,
      debug,
    };
  } catch (e) {
    if (newCampResource && newCampId) {
      await persistLocalCampaignAndFunnel(admin, {
        userId,
        dstSiteId: a.dstSiteId,
        dstGoogleAccountId: a.dstAcc.id,
        campaignId: newCampId,
        campaignName: newName,
        budgetMicros: newBudgetMicros,
        initialBudget: a.initialBudget,
      }).catch(() => {});
    }
    return { ok: false, partial: !!newCampResource, new_campaign_id: newCampId || undefined, error: String((e as Error).message || e), debug };
  }
}

// =============== HELPERS ===============

async function getAccessToken(refreshToken: string) {
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
  return j.access_token as string;
}

function buildHeaders(token: string, loginCid: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
    "Content-Type": "application/json",
  };
  if (loginCid) h["login-customer-id"] = loginCid;
  return h;
}

async function searchAll(apiBase: string, headers: Record<string, string>, query: string): Promise<any[]> {
  const res = await fetch(`${apiBase}/googleAds:searchStream`, {
    method: "POST", headers, body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`searchStream: ${extractError(parsed)}`);
  const out: any[] = [];
  for (const b of (Array.isArray(parsed) ? parsed : [parsed])) if (b?.results) out.push(...b.results);
  return out;
}

async function mutate(apiBase: string, headers: Record<string, string>, resource: string, ops: any[], step: string, contexts: any[] = []) {
  const results: any[] = [];
  let partialFailureError: any = null;
  const errors: any[] = [];
  if (ops.length === 0) return { created: 0, results, partialFailureError };
  for (let i = 0; i < ops.length; i += 100) {
    const chunk = ops.slice(i, i + 100);
    const chunkContexts = contexts.slice(i, i + 100);
    const res = await fetch(`${apiBase}/${resource}:mutate`, {
      method: "POST", headers, body: JSON.stringify({ operations: chunk, partialFailure: true }),
    });
    const text = await res.text();
    let j: any; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!res.ok) {
      console.error(`[migration] ${step} HTTP error`, JSON.stringify(j));
      partialFailureError = j;
      errors.push(...normalizeGoogleErrors(j, chunkContexts, i));
      continue;
    }
    results.push(...(j.results ?? []));
    if (j.partialFailureError) {
      console.error(`[migration] ${step} partial`, JSON.stringify(j.partialFailureError));
      partialFailureError = j.partialFailureError;
      errors.push(...normalizeGoogleErrors(j.partialFailureError, chunkContexts, i));
    }
  }
  return { created: results.filter((x: any) => x?.resourceName).length, results, partialFailureError, errors };
}

async function removeCampaign(apiBase: string, headers: Record<string, string>, resource: string) {
  if (!resource) return;
  await fetch(`${apiBase}/campaigns:mutate`, {
    method: "POST", headers,
    body: JSON.stringify({
      operations: [{ update: { resourceName: resource, status: "REMOVED" }, updateMask: "status" }],
      partialFailure: true,
    }),
  }).catch(() => {});
}

async function persistLocalCampaignAndFunnel(admin: any, row: {
  userId: string;
  dstSiteId: string;
  dstGoogleAccountId: string;
  campaignId: string;
  campaignName: string;
  budgetMicros: number;
  initialBudget: number;
}) {
  if (!row.campaignId) return;
  await admin.from("campaigns").upsert({
    user_id: row.userId,
    google_account_id: row.dstGoogleAccountId,
    campaign_id: row.campaignId,
    name: row.campaignName,
    status: "paused",
    channel_type: "DISPLAY",
    budget_micros: row.budgetMicros,
  }, { onConflict: "user_id,google_account_id,campaign_id" });

  await admin.from("campaign_funnel").upsert({
    user_id: row.userId,
    site_id: row.dstSiteId,
    google_account_id: row.dstGoogleAccountId,
    campaign_id: row.campaignId,
    campaign_name: row.campaignName,
    funnel_status: "learning",
    entry_source: "migration",
    initial_budget: row.initialBudget,
    current_budget: row.initialBudget,
  }, { onConflict: "user_id,campaign_id" });
}

function normalizeGoogleErrors(err: any, contexts: any[] = [], baseIndex = 0): any[] {
  const details = err?.error?.details ?? err?.details ?? [];
  const out: any[] = [];
  for (const d of details) {
    for (const e of d?.errors ?? []) {
      const operationIndex = Number(e?.location?.fieldPathElements?.find((p: any) => p?.fieldName === "operations")?.index ?? NaN);
      const localIndex = Number.isFinite(operationIndex) ? operationIndex : null;
      const ctx = localIndex !== null ? contexts[localIndex] : undefined;
      out.push({
        operation_index: localIndex !== null ? baseIndex + localIndex : null,
        field_path: fieldPath(e?.location?.fieldPathElements),
        error_code: e?.errorCode ?? null,
        message: e?.message ?? extractError(e),
        trigger: e?.trigger ?? null,
        context: ctx ?? null,
        raw: e,
      });
    }
  }
  if (out.length) return out;
  return [{ operation_index: null, field_path: null, message: extractError(err), raw: err }];
}

function fieldPath(parts: any[] | undefined): string | null {
  if (!Array.isArray(parts)) return null;
  return parts.map((p) => p?.index !== undefined ? `${p.fieldName}[${p.index}]` : p?.fieldName).filter(Boolean).join(".") || null;
}

async function readCampaignCriteria(apiBase: string, headers: Record<string, string>, campResource: string, debug: any) {
  const base = "campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.status, campaign_criterion.negative, campaign_criterion.bid_modifier";
  const queries = [
    { label: "LANGUAGE", fields: "campaign_criterion.language.language_constant" },
    { label: "LOCATION", fields: "campaign_criterion.location.geo_target_constant" },
    { label: "PROXIMITY", fields: "campaign_criterion.proximity.geo_point.longitude_in_micro_degrees, campaign_criterion.proximity.geo_point.latitude_in_micro_degrees, campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units" },
    { label: "DEVICE", fields: "campaign_criterion.device.type" },
    { label: "AD_SCHEDULE", fields: "campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute" },
    { label: "AGE_RANGE", fields: "campaign_criterion.age_range.type" },
    { label: "GENDER", fields: "campaign_criterion.gender.type" },
    { label: "INCOME_RANGE", fields: "campaign_criterion.income_range.type" },
    { label: "PARENTAL_STATUS", fields: "campaign_criterion.parental_status.type" },
    { label: "USER_LIST", fields: "campaign_criterion.user_list.user_list" },
    { label: "AUDIENCE", fields: "campaign_criterion.audience.audience" },
    { label: "TOPIC", fields: "campaign_criterion.topic.topic_constant" },
    { label: "PLACEMENT", fields: "campaign_criterion.placement.url" },
  ];
  const rows: any[] = [];
  for (const q of queries) {
    try {
      rows.push(...await searchAll(apiBase, headers, `
        SELECT ${base}, ${q.fields}
        FROM campaign_criterion
        WHERE campaign_criterion.campaign = '${campResource}' AND campaign_criterion.type = ${q.label} AND campaign_criterion.status != 'REMOVED'
      `));
    } catch (e) {
      debug.partial_failures.push({ step: `read_camp_crit_${q.label}`, error: String((e as Error).message || e) });
    }
  }
  return rows;
}

async function readAdGroupCriteria(apiBase: string, headers: Record<string, string>, srcAgRefs: string, debug: any) {
  try {
    return await searchAll(apiBase, headers, `
      SELECT ad_group.id,
             ad_group_criterion.resource_name, ad_group_criterion.type, ad_group_criterion.status,
             ad_group_criterion.negative, ad_group_criterion.bid_modifier,
             ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group_criterion.placement.url,
             ad_group_criterion.user_list.user_list,
             ad_group_criterion.audience.audience,
             ad_group_criterion.topic.topic_constant,
             ad_group_criterion.age_range.type,
             ad_group_criterion.gender.type,
             ad_group_criterion.income_range.type,
             ad_group_criterion.parental_status.type
      FROM ad_group_criterion
      WHERE ad_group_criterion.ad_group IN (${srcAgRefs}) AND ad_group_criterion.status != 'REMOVED'
    `);
  } catch (e) {
    debug.partial_failures.push({ step: "read_ag_crit", error: String((e as Error).message || e) });
    return [];
  }
}

function buildCriterionOp(scope: "campaign" | "adGroup", c: any, parent: string, opts: { skipAudiences: boolean }) {
  if (!c) return null;
  const t = c.type;
  // Audiences/user lists não portam entre contas
  if (opts.skipAudiences && ["USER_LIST", "AUDIENCE", "COMBINED_AUDIENCE", "CUSTOM_AUDIENCE"].includes(t)) return null;

  const create: any = scope === "campaign" ? { campaign: parent } : { adGroup: parent };
  if (typeof c.negative === "boolean") create.negative = c.negative;
  const bid = Number(c.bidModifier);
  if (Number.isFinite(bid) && bid !== 1 && bid !== 0) create.bidModifier = bid;

  switch (t) {
    case "LANGUAGE":
      if (!c.language?.languageConstant) return null;
      create.language = { languageConstant: c.language.languageConstant }; break;
    case "LOCATION":
      if (!c.location?.geoTargetConstant) return null;
      create.location = { geoTargetConstant: c.location.geoTargetConstant }; break;
    case "PROXIMITY":
      if (!c.proximity?.geoPoint) return null;
      create.proximity = clean({
        geoPoint: c.proximity.geoPoint,
        radius: c.proximity.radius,
        radiusUnits: c.proximity.radiusUnits,
      }); break;
    case "DEVICE":
      if (!c.device?.type) return null;
      create.device = { type: c.device.type }; break;
    case "AD_SCHEDULE":
      if (!c.adSchedule) return null;
      create.adSchedule = clean({
        dayOfWeek: c.adSchedule.dayOfWeek,
        startHour: c.adSchedule.startHour, startMinute: c.adSchedule.startMinute,
        endHour: c.adSchedule.endHour, endMinute: c.adSchedule.endMinute,
      }); break;
    case "AGE_RANGE":
      if (!c.ageRange?.type) return null;
      create.ageRange = { type: c.ageRange.type }; break;
    case "GENDER":
      if (!c.gender?.type) return null;
      create.gender = { type: c.gender.type }; break;
    case "INCOME_RANGE":
      if (!c.incomeRange?.type) return null;
      create.incomeRange = { type: c.incomeRange.type }; break;
    case "PARENTAL_STATUS":
      if (!c.parentalStatus?.type) return null;
      create.parentalStatus = { type: c.parentalStatus.type }; break;
    case "USER_LIST":
      if (!c.userList?.userList) return null;
      create.userList = { userList: c.userList.userList }; break;
    case "AUDIENCE":
      if (!c.audience?.audience) return null;
      create.audience = { audience: c.audience.audience }; break;
    case "TOPIC":
      if (!c.topic?.topicConstant) return null;
      create.topic = { topicConstant: c.topic.topicConstant }; break;
    case "PLACEMENT":
      if (!c.placement?.url) return null;
      create.placement = { url: c.placement.url }; break;
    case "KEYWORD":
      if (!c.keyword?.text) return null;
      create.keyword = { text: c.keyword.text, matchType: c.keyword.matchType ?? "BROAD" }; break;
    default: return null;
  }
  return { create: clean(create) };
}

function buildAd(ad: any, assetMap: Map<string, string>, crossAccount: boolean, debug: any, sourceAdGroupId: string) {
  // ===== HTML5 / display upload =====
  if (ad?.displayUploadAd) {
    const dua = ad.displayUploadAd;
    const sourceBundleRef = dua.mediaBundle?.asset;
    if (!sourceBundleRef) {
      debug.partial_failures.push({ step: "build_display_upload_ad", source_ad_group_id: String(sourceAdGroupId ?? ""), source_ad_id: String(ad.id ?? ""), missing_fields: ["media_bundle"] });
      return null;
    }
    const newBundle = crossAccount ? assetMap.get(sourceBundleRef) : sourceBundleRef;
    if (!newBundle) {
      debug.partial_failures.push({ step: "build_display_upload_ad", source_ad_group_id: String(sourceAdGroupId ?? ""), source_ad_id: String(ad.id ?? ""), source_asset: sourceBundleRef, message: "media_bundle não foi re-uploadado" });
      return null;
    }
    return clean({
      name: ad.name,
      displayUploadAd: clean({
        displayUploadProductType: dua.displayUploadProductType ?? "HTML5_UPLOAD_AD",
        mediaBundle: { asset: newBundle },
      }),
    });
  }
  if (!ad?.responsiveDisplayAd) return null; // tipos não suportados
  const rda = ad.responsiveDisplayAd;
  const missingAssets: any[] = [];
  const remap = (items: any[] | undefined, field: string) => (items ?? [])
    .map((it: any) => {
      if (!it?.asset) return null;
      const newAsset = crossAccount ? assetMap.get(it.asset) : it.asset;
      if (crossAccount && !newAsset) missingAssets.push({ field, source_asset: it.asset, source_ad_group_id: String(sourceAdGroupId ?? ""), source_ad_id: String(ad.id ?? "") });
      if (!newAsset) return null;
      return { asset: newAsset };
    }).filter(Boolean);
  const built: any = clean({
    name: ad.name,
    responsiveDisplayAd: clean({
      headlines: (rda.headlines ?? []).map((h: any) => h?.text ? clean({ text: h.text, pinnedField: h.pinnedField }) : null).filter(Boolean),
      longHeadline: rda.longHeadline?.text ? { text: rda.longHeadline.text } : undefined,
      descriptions: (rda.descriptions ?? []).map((h: any) => h?.text ? clean({ text: h.text, pinnedField: h.pinnedField }) : null).filter(Boolean),
      businessName: rda.businessName,
      marketingImages: remap(rda.marketingImages, "marketing_images"),
      squareMarketingImages: remap(rda.squareMarketingImages, "square_marketing_images"),
      logoImages: remap(rda.logoImages, "logo_images"),
      squareLogoImages: remap(rda.squareLogoImages, "square_logo_images"),
      youtubeVideos: remap(rda.youtubeVideos, "youtube_videos"),
      callToActionText: rda.callToActionText,
      allowFlexibleColor: rda.allowFlexibleColor,
      accentColor: rda.accentColor,
      mainColor: rda.mainColor,
      formatSetting: rda.formatSetting,
    }),
  });
  if (missingAssets.length) debug.partial_failures.push({ step: "build_ad_asset_mapping", errors: missingAssets });
  // RDA precisa ser reconstruído do zero com textos + imagens + logo + business name.
  const r = built.responsiveDisplayAd;
  const missingFields = [];
  if (!r.headlines?.length) missingFields.push("headlines");
  if (!r.longHeadline) missingFields.push("long_headline");
  if (!r.descriptions?.length) missingFields.push("descriptions");
  if (!r.businessName) missingFields.push("business_name");
  if (!r.marketingImages?.length) missingFields.push("marketing_images");
  if (!r.squareMarketingImages?.length) missingFields.push("square_marketing_images");
  if (!r.logoImages?.length && !r.squareLogoImages?.length) missingFields.push("logo_images");
  if (missingFields.length) {
    debug.partial_failures.push({ step: "build_responsive_display_ad", source_ad_group_id: String(sourceAdGroupId ?? ""), source_ad_id: String(ad.id ?? ""), missing_fields: missingFields });
    return null;
  }
  return built;
}

async function reuploadAssets(
  srcBase: string, srcHeaders: Record<string, string>,
  dstBase: string, dstHeaders: Record<string, string>,
  _dstCustomerId: string, refs: string[],
): Promise<{ map: Map<string, string>; skipped: number; errors: any[] }> {
  const map = new Map<string, string>();
  const errors: any[] = [];
  let skipped = 0;
  // Lê data/url dos assets origem
  // resourceName tipo: customers/X/assets/123 → id=123
  const ids = refs.map((r) => r.split("/").pop()!).filter(Boolean);
  const idChunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) idChunks.push(ids.slice(i, i + 50));

  const srcAssets = new Map<string, any>(); // id → asset row
  for (const ch of idChunks) {
    try {
      const rows = await searchAll(srcBase, srcHeaders, `
        SELECT asset.resource_name, asset.id, asset.type, asset.name,
               asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels,
               asset.image_asset.mime_type,
               asset.youtube_video_asset.youtube_video_id
        FROM asset
        WHERE asset.id IN (${ch.join(",")})
      `);
      for (const r of rows) srcAssets.set(String(r.asset?.id), r.asset);
    } catch (e) {
      errors.push({ step: "read_assets", message: String((e as Error).message || e), asset_ids: ch });
    }
  }

  // Re-cria por tipo
  for (const ref of refs) {
    const id = ref.split("/").pop()!;
    const asset = srcAssets.get(id);
    if (!asset) { skipped++; continue; }
    try {
      if (asset.type === "IMAGE" && asset.imageAsset?.fullSize?.url) {
        const imgRes = await fetch(asset.imageAsset.fullSize.url);
        if (!imgRes.ok) { skipped++; errors.push({ step: "download_image", source_asset: ref, asset_id: id, http_status: imgRes.status, message: `HTTP ${imgRes.status}` }); continue; }
        const buf = new Uint8Array(await imgRes.arrayBuffer());
        const b64 = base64Encode(buf);
        const create: any = {
          name: asset.name || `migrated-${id}-${Date.now()}`,
          type: "IMAGE",
          imageAsset: { data: b64 },
        };
        const r = await mutate(dstBase, dstHeaders, "assets", [{ create }], `reupload_image_${id}`, [{ source_asset: ref, asset_id: id, asset_name: asset.name, asset_type: asset.type }]);
        const newRn = r.results[0]?.resourceName;
        if (newRn) map.set(ref, newRn);
        else { skipped++; errors.push(...(r.errors?.length ? r.errors : [{ step: "upload_image", source_asset: ref, asset_id: id, message: extractError(r.partialFailureError) }])); }
      } else if (asset.type === "YOUTUBE_VIDEO" && asset.youtubeVideoAsset?.youtubeVideoId) {
        const create: any = {
          name: asset.name || `migrated-yt-${id}-${Date.now()}`,
          type: "YOUTUBE_VIDEO",
          youtubeVideoAsset: { youtubeVideoId: asset.youtubeVideoAsset.youtubeVideoId },
        };
        const r = await mutate(dstBase, dstHeaders, "assets", [{ create }], `reupload_yt_${id}`, [{ source_asset: ref, asset_id: id, asset_name: asset.name, asset_type: asset.type }]);
        const newRn = r.results[0]?.resourceName;
        if (newRn) map.set(ref, newRn);
        else { skipped++; errors.push(...(r.errors?.length ? r.errors : [{ step: "upload_youtube", source_asset: ref, asset_id: id, message: extractError(r.partialFailureError) }])); }
      } else if (asset.type === "MEDIA_BUNDLE") {
        // Google Ads API NÃO expõe os bytes do ZIP do HTML5 (write-only).
        // Não é possível baixar e re-uploadar. Marca como pendente para upload manual.
        skipped++;
        errors.push({
          step: "html5_bundle_not_portable",
          source_asset: ref, asset_id: id, asset_type: asset.type,
          message: "Bundle HTML5 não pode ser baixado pela API (write-only). Faça o re-upload manual do ZIP no ad group da nova campanha.",
        });
      } else {
        skipped++;
        errors.push({ step: "unsupported_asset", source_asset: ref, asset_id: id, asset_type: asset.type, message: "asset sem dados de imagem/vídeo portáveis" });
      }
    } catch (e) {
      errors.push({ step: "asset_exception", source_asset: ref, asset_id: id, message: String((e as Error).message || e) });
      skipped++;
    }
  }
  return { map, skipped, errors };
}

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function clean<T extends Record<string, any>>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = (o as any)[k];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) delete (o as any)[k];
  }
  return o;
}

function extractError(j: any): string {
  if (!j) return "";
  return j?.error?.details?.[0]?.errors?.[0]?.message ?? j?.error?.message ?? JSON.stringify(j);
}
