// Lista anúncios reprovados / limitados por política nas campanhas de Display
// (as "recomendadas" / responsivas) e Demand Gen de todas as contas do usuário,
// com as imagens de cada anúncio — pra achar e tirar o criativo problemático.
//
// Só leitura. A API (v24) NÃO diz qual imagem de um anúncio com vários recursos
// foi reprovada (ad_group_ad_asset_view.policy_summary não existe pra Display /
// Demand Gen) — por isso devolvemos todas as imagens + o link da tela
// "Detalhes do recurso" do Google Ads, que mostra qual é.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getAccessTokenFor, devTokenFor } from "../_shared/google_api_set.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Campos de imagem por tipo de anúncio (nome REST → nome do campo no update_mask)
const IMAGE_FIELDS: Array<{ path: [string, string]; mask: string; label: string }> = [
  { path: ["responsiveDisplayAd", "marketingImages"], mask: "responsive_display_ad.marketing_images", label: "Horizontal" },
  { path: ["responsiveDisplayAd", "squareMarketingImages"], mask: "responsive_display_ad.square_marketing_images", label: "Quadrada" },
  { path: ["responsiveDisplayAd", "logoImages"], mask: "responsive_display_ad.logo_images", label: "Logo horizontal" },
  { path: ["responsiveDisplayAd", "squareLogoImages"], mask: "responsive_display_ad.square_logo_images", label: "Logo" },
  { path: ["demandGenMultiAssetAd", "marketingImages"], mask: "demand_gen_multi_asset_ad.marketing_images", label: "Horizontal" },
  { path: ["demandGenMultiAssetAd", "squareMarketingImages"], mask: "demand_gen_multi_asset_ad.square_marketing_images", label: "Quadrada" },
  { path: ["demandGenMultiAssetAd", "portraitMarketingImages"], mask: "demand_gen_multi_asset_ad.portrait_marketing_images", label: "Vertical" },
  { path: ["demandGenMultiAssetAd", "tallPortraitMarketingImages"], mask: "demand_gen_multi_asset_ad.tall_portrait_marketing_images", label: "Vertical 9:16" },
  { path: ["demandGenMultiAssetAd", "logoImages"], mask: "demand_gen_multi_asset_ad.logo_images", label: "Logo" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });
    const body = await req.json().catch(() => ({}));
    const requestedSiteId: string | null = typeof (body as any)?.site_id === "string" ? (body as any).site_id : null;
    const includePaused = !!(body as any)?.include_paused;

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let accountIds: string[];
    if (requestedSiteId && requestedSiteId !== "all") {
      const { data: links } = await admin
        .from("account_site_links")
        .select("google_account_id")
        .eq("user_id", userId)
        .eq("site_id", requestedSiteId);
      accountIds = [...new Set((links ?? []).map((l: { google_account_id: string }) => l.google_account_id))];
    } else {
      const { data: accs } = await admin.from("google_accounts").select("id").eq("user_id", userId);
      accountIds = (accs ?? []).map((a: { id: string }) => a.id);
    }
    if (accountIds.length === 0) return json({ ok: true, ads: [], errors: [] });

    const { data: accounts } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id, api_set, account_name, descriptive_name, is_mcc")
      .in("id", accountIds);
    const targets = (accounts ?? []).filter((a: any) => a.refresh_token && a.customer_id && !a.is_mcc);

    const ads: any[] = [];
    const errors: Array<{ account: string; error: string }> = [];

    // Cada conta isolada — conta suspensa ou sem acesso não derruba as outras.
    await Promise.all(targets.map(async (acc: any) => {
      const label = acc.descriptive_name || acc.account_name || acc.customer_id;
      try {
        const apiSet = acc.api_set ?? 1;
        const accessToken = await getAccessTokenFor(acc.refresh_token, apiSet);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devTokenFor(apiSet),
          "Content-Type": "application/json",
        };
        if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;
        const search = async (query: string) => {
          const out: any[] = [];
          let pageToken: string | undefined;
          do {
            const r = await fetch(`https://googleads.googleapis.com/v24/customers/${acc.customer_id}/googleAds:search`, {
              method: "POST", headers, body: JSON.stringify({ query, pageToken }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error?.details?.[0]?.errors?.[0]?.message ?? j?.error?.message ?? JSON.stringify(j).slice(0, 300));
            out.push(...(j.results ?? []));
            pageToken = j.nextPageToken || undefined;
          } while (pageToken);
          return out;
        };

        const rows = await search(`
          SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                 ad_group.id, ad_group.name,
                 ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status,
                 ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.policy_topic_entries,
                 ad_group_ad.ad.image_ad.image_url, ad_group_ad.ad.image_ad.name,
                 ad_group_ad.ad.responsive_display_ad.marketing_images,
                 ad_group_ad.ad.responsive_display_ad.square_marketing_images,
                 ad_group_ad.ad.responsive_display_ad.logo_images,
                 ad_group_ad.ad.responsive_display_ad.square_logo_images,
                 ad_group_ad.ad.demand_gen_multi_asset_ad.marketing_images,
                 ad_group_ad.ad.demand_gen_multi_asset_ad.square_marketing_images,
                 ad_group_ad.ad.demand_gen_multi_asset_ad.portrait_marketing_images,
                 ad_group_ad.ad.demand_gen_multi_asset_ad.tall_portrait_marketing_images,
                 ad_group_ad.ad.demand_gen_multi_asset_ad.logo_images
          FROM ad_group_ad
          WHERE campaign.advertising_channel_type IN ('DISPLAY', 'DEMAND_GEN')
            AND ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY')
            AND ad_group_ad.status != 'REMOVED'
            AND ad_group.status != 'REMOVED'
            AND campaign.status ${includePaused ? "!= 'REMOVED'" : "= 'ENABLED'"}
        `);
        if (rows.length === 0) return;

        // URL/nome das imagens usadas nesses anúncios
        const assetRns = new Set<string>();
        for (const r of rows) {
          const ad = r.adGroupAd?.ad ?? {};
          for (const f of IMAGE_FIELDS) for (const a of ad?.[f.path[0]]?.[f.path[1]] ?? []) if (a?.asset) assetRns.add(a.asset);
        }
        const assetInfo = new Map<string, { name: string; url: string }>();
        const ids = [...assetRns].map((rn) => rn.split("/").pop()).filter(Boolean);
        for (let i = 0; i < ids.length; i += 400) {
          const chunk = ids.slice(i, i + 400);
          const aRows = await search(`SELECT asset.resource_name, asset.name, asset.image_asset.full_size.url FROM asset WHERE asset.id IN (${chunk.join(",")})`);
          for (const a of aRows) {
            assetInfo.set(a.asset.resourceName, { name: a.asset.name ?? "", url: a.asset.imageAsset?.fullSize?.url ?? "" });
          }
        }

        for (const r of rows) {
          const ad = r.adGroupAd?.ad ?? {};
          const images: any[] = [];
          for (const f of IMAGE_FIELDS) {
            for (const a of ad?.[f.path[0]]?.[f.path[1]] ?? []) {
              if (!a?.asset) continue;
              const info = assetInfo.get(a.asset);
              images.push({ asset: a.asset, asset_id: a.asset.split("/").pop(), field: f.mask, kind: f.label, name: info?.name ?? "", url: info?.url ?? "" });
            }
          }
          if (ad.imageAd?.imageUrl) images.push({ asset: null, asset_id: null, field: null, kind: "Imagem única", name: ad.imageAd?.name ?? "", url: ad.imageAd.imageUrl });
          ads.push({
            google_account_id: acc.id,
            account: label,
            customer_id: acc.customer_id,
            campaign_id: String(r.campaign?.id ?? ""),
            campaign_name: r.campaign?.name ?? "",
            campaign_status: r.campaign?.status ?? "",
            channel: r.campaign?.advertisingChannelType ?? "",
            ad_group_id: String(r.adGroup?.id ?? ""),
            ad_id: String(ad.id ?? ""),
            ad_type: ad.type ?? "",
            ad_status: r.adGroupAd?.status ?? "",
            approval: r.adGroupAd?.policySummary?.approvalStatus ?? "",
            topics: (r.adGroupAd?.policySummary?.policyTopicEntries ?? []).map((t: any) => ({ topic: t.topic, type: t.type })),
            images,
          });
        }
      } catch (e) {
        errors.push({ account: label, error: String(e instanceof Error ? e.message : e).slice(0, 300) });
      }
    }));

    // Reprovados primeiro, depois campanhas ativas
    const rank = (a: any) => (a.approval === "DISAPPROVED" ? 0 : 1) * 2 + (a.campaign_status === "ENABLED" ? 0 : 1);
    ads.sort((a, b) => rank(a) - rank(b) || a.account.localeCompare(b.account) || a.campaign_name.localeCompare(b.campaign_name));
    return json({ ok: true, ads, errors, accounts: targets.length });
  } catch (e) {
    console.error("[google-ads-policy-issues]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});
