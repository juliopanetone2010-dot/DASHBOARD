// Recebe um ZIP HTML5, sobe como MEDIA_BUNDLE asset na conta destino e cria o ad pendente.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { devTokenFor, getCreds } from "../_shared/google_api_set.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface Body {
  pending_ad_id: string;
  zip_base64: string; // ZIP em base64 (incluindo data: prefix opcional)
  zip_filename?: string;
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

    const body = (await req.json()) as Body;
    if (!body?.pending_ad_id || !body?.zip_base64) return json({ error: "campos obrigatórios: pending_ad_id, zip_base64" }, 400);

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: pending, error: pErr } = await admin
      .from("migration_pending_ads").select("*").eq("id", body.pending_ad_id).eq("user_id", userId).maybeSingle();
    if (pErr || !pending) return json({ error: "pending ad não encontrado" }, 404);
    if (pending.status === "uploaded") return json({ error: "anúncio já foi recriado" }, 400);

    const { data: dstAcc } = await admin.from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id, is_mcc, account_name, api_set")
      .eq("id", pending.destination_google_account_id).eq("user_id", userId).maybeSingle();
    if (!dstAcc?.refresh_token) return json({ error: "conta destino sem refresh_token" }, 400);
    if (dstAcc.is_mcc) {
      const msg = `A conta destino "${dstAcc.account_name || dstAcc.customer_id}" é uma MCC (manager). Não é possível criar anúncios numa MCC — escolha uma conta-filha como destino e rode a migração novamente.`;
      await admin.from("migration_pending_ads").update({ status: "failed", reason: msg }).eq("id", pending.id);
      return json({ error: msg }, 400);
    }

    // Normaliza base64 (remove prefixo data: se presente)
    const b64 = body.zip_base64.includes(",") ? body.zip_base64.split(",")[1] : body.zip_base64;
    // Validação básica do tamanho
    const approxBytes = Math.floor((b64.length * 3) / 4);
    if (approxBytes > 12 * 1024 * 1024) return json({ error: "ZIP muito grande (limite 12MB)" }, 400);

    // Salva no Storage
    const filename = body.zip_filename?.replace(/[^a-zA-Z0-9._-]/g, "_") || `bundle-${Date.now()}.zip`;
    const path = `${userId}/${pending.id}/${filename}`;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const up = await admin.storage.from("html5-bundles").upload(path, bytes, {
        contentType: "application/zip", upsert: true,
      });
      if (up.error) console.error("storage upload error:", up.error);
    } catch (e) { console.error("storage encoding error:", (e as Error).message); }

    const { clientId, clientSecret, devToken } = getCreds((dstAcc as any).api_set ?? 1);
    // Token + headers para Google Ads
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: dstAcc.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json({ error: `oauth: ${JSON.stringify(tokenJson)}` }, 500);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokenJson.access_token}`,
      "developer-token": devToken,
      "Content-Type": "application/json",
    };
    if (dstAcc.login_customer_id) headers["login-customer-id"] = dstAcc.login_customer_id;

    // CRÍTICO: usar o customer_id que está DENTRO do destination_ad_group_resource,
    // não o do google_accounts (podem divergir se a conta foi remapeada).
    const agResource = String(pending.destination_ad_group_resource || "");
    const agCustomerMatch = agResource.match(/^customers\/(\d+)\/adGroups\//);
    const operatingCustomerId = agCustomerMatch?.[1] || pending.destination_customer_id || dstAcc.customer_id;
    if (operatingCustomerId !== dstAcc.customer_id) {
      console.warn(`[html5-upload] customer mismatch: dstAcc=${dstAcc.customer_id} ad_group=${operatingCustomerId} — usando ${operatingCustomerId}`);
    }
    const apiBase = `https://googleads.googleapis.com/v18/customers/${operatingCustomerId}`;

    // 0) Valida que o ad group destino ainda existe e não está removido
    try {
      const agRn = pending.destination_ad_group_resource as string;
      const agId = agRn?.split("/").pop();
      const searchRes = await fetch(`${apiBase}/googleAds:search`, {
        method: "POST", headers,
        body: JSON.stringify({
          query: `SELECT ad_group.id, ad_group.status, campaign.status FROM ad_group WHERE ad_group.id = ${agId}`,
        }),
      });
      const searchJ = await searchRes.json();
      const row = searchJ?.results?.[0];
      const agStatus = row?.adGroup?.status;
      const campStatus = row?.campaign?.status;
      if (!row || agStatus === "REMOVED" || campStatus === "REMOVED") {
        const msg = !row
          ? "ad group destino não encontrado (foi removido?)"
          : `ad group ou campanha destino está REMOVED (ad_group=${agStatus}, campaign=${campStatus}). Recrie a campanha destino antes de subir o HTML5.`;
        await admin.from("migration_pending_ads").update({ status: "failed", reason: msg }).eq("id", pending.id);
        return json({ error: msg }, 400);
      }
    } catch (e) {
      console.error("ad_group validation error:", (e as Error).message);
    }

    // 1) Cria asset MEDIA_BUNDLE
    const assetCreate = {
      name: pending.source_ad_name ? `${pending.source_ad_name}-${Date.now()}` : `html5-${Date.now()}`,
      type: "MEDIA_BUNDLE",
      mediaBundleAsset: { data: b64 },
    };
    const assetRes = await fetch(`${apiBase}/assets:mutate`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{ create: assetCreate }], partialFailure: false }),
    });
    const assetJ = await assetRes.json();
    if (!assetRes.ok || !assetJ?.results?.[0]?.resourceName) {
      const msg = assetJ?.error?.details?.[0]?.errors?.[0]?.message || assetJ?.error?.message || JSON.stringify(assetJ);
      await admin.from("migration_pending_ads").update({ reason: `falha asset: ${msg}` }).eq("id", pending.id);
      return json({ error: `falha criando asset MEDIA_BUNDLE: ${msg}` }, 500);
    }
    const newAssetRn = assetJ.results[0].resourceName;

    // 2) Cria adGroupAd com displayUploadAd
    const adCreate = {
      adGroup: pending.destination_ad_group_resource,
      status: "ENABLED",
      ad: {
        name: pending.source_ad_name || `html5-migrated-${Date.now()}`,
        finalUrls: [pending.final_url],
        ...(pending.final_url_suffix ? { finalUrlSuffix: pending.final_url_suffix } : {}),
        displayUploadAd: {
          displayUploadProductType: pending.display_upload_product_type || "HTML5_UPLOAD_AD",
          mediaBundle: { asset: newAssetRn },
        },
      },
    };
    const adRes = await fetch(`${apiBase}/adGroupAds:mutate`, {
      method: "POST", headers,
      body: JSON.stringify({ operations: [{ create: adCreate }], partialFailure: false }),
    });
    const adJ = await adRes.json();
    if (!adRes.ok || !adJ?.results?.[0]?.resourceName) {
      const rawMsg = adJ?.error?.details?.[0]?.errors?.[0]?.message || adJ?.error?.message || JSON.stringify(adJ);
      const errCode = adJ?.error?.details?.[0]?.errors?.[0]?.errorCode || {};
      console.error("[html5-upload] adGroupAds:mutate failed", JSON.stringify({
        status: adRes.status, rawMsg, errCode,
        operatingCustomerId, dstCustomerId: dstAcc.customer_id,
        loginCustomerId: dstAcc.login_customer_id,
        adGroup: pending.destination_ad_group_resource,
        assetRn: newAssetRn,
        fullError: adJ?.error,
      }));
      const isRemoved = /not allowed for removed resources/i.test(rawMsg);
      const friendly = `Google Ads erro [${adRes.status}]: ${rawMsg}`;
      await admin.from("migration_pending_ads").update({ status: "failed", reason: `asset criado mas ad falhou: ${friendly}`, zip_storage_path: path }).eq("id", pending.id);
      return json({
        error: friendly,
        raw: rawMsg,
        google_error_code: errCode,
        operating_customer_id: operatingCustomerId,
        dst_customer_id: dstAcc.customer_id,
        login_customer_id: dstAcc.login_customer_id,
        ad_group_resource: pending.destination_ad_group_resource,
        asset_resource: newAssetRn,
        removed_destination: isRemoved,
      }, 400);
    }

    await admin.from("migration_pending_ads").update({
      status: "uploaded",
      zip_storage_path: path,
      uploaded_ad_resource: adJ.results[0].resourceName,
      resolved_at: new Date().toISOString(),
      reason: null,
    }).eq("id", pending.id);

    return json({ ok: true, ad_resource: adJ.results[0].resourceName, asset_resource: newAssetRn });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
