// Recebe um ZIP HTML5, sobe como MEDIA_BUNDLE asset na conta destino e cria o ad pendente.
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
      .select("id, customer_id, refresh_token, login_customer_id")
      .eq("id", pending.destination_google_account_id).eq("user_id", userId).maybeSingle();
    if (!dstAcc?.refresh_token) return json({ error: "conta destino sem refresh_token" }, 400);

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

    // Token + headers para Google Ads
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
        refresh_token: dstAcc.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json({ error: `oauth: ${JSON.stringify(tokenJson)}` }, 500);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokenJson.access_token}`,
      "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
      "Content-Type": "application/json",
    };
    if (dstAcc.login_customer_id) headers["login-customer-id"] = dstAcc.login_customer_id;
    const apiBase = `https://googleads.googleapis.com/v21/customers/${dstAcc.customer_id}`;

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
      const msg = adJ?.error?.details?.[0]?.errors?.[0]?.message || adJ?.error?.message || JSON.stringify(adJ);
      await admin.from("migration_pending_ads").update({ reason: `asset criado mas ad falhou: ${msg}`, zip_storage_path: path }).eq("id", pending.id);
      return json({ error: `asset OK porém adGroupAd falhou: ${msg}`, asset_resource: newAssetRn }, 500);
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
