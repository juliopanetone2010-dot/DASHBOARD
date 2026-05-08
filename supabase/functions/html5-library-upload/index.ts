// Salva ZIPs HTML5 na biblioteca (reutilizáveis em migrações futuras).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(p: unknown, s = 200) {
  return new Response(JSON.stringify(p), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface Body {
  source_google_account_id?: string | null;
  source_campaign_id?: string | null;
  source_campaign_name?: string | null;
  source_ad_id?: string | null;
  source_ad_name?: string | null;
  zip_base64: string;
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
    if (!body?.zip_base64) return json({ error: "zip_base64 obrigatório" }, 400);

    const b64 = body.zip_base64.includes(",") ? body.zip_base64.split(",")[1] : body.zip_base64;
    const approxBytes = Math.floor((b64.length * 3) / 4);
    if (approxBytes > 12 * 1024 * 1024) return json({ error: "ZIP muito grande (limite 12MB)" }, 400);

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const filename = (body.zip_filename || `bundle-${Date.now()}.zip`).replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `library/${userId}/${body.source_ad_id || "noid"}-${Date.now()}-${filename}`;

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const up = await admin.storage.from("html5-bundles").upload(path, bytes, {
      contentType: "application/zip", upsert: true,
    });
    if (up.error) return json({ error: `storage: ${up.error.message}` }, 500);

    const { data: row, error: insErr } = await admin.from("html5_bundle_library").insert({
      user_id: userId,
      source_google_account_id: body.source_google_account_id || null,
      source_campaign_id: body.source_campaign_id || null,
      source_campaign_name: body.source_campaign_name || null,
      source_ad_id: body.source_ad_id || null,
      source_ad_name: body.source_ad_name || null,
      zip_storage_path: path,
      zip_filename: filename,
      file_size: approxBytes,
    }).select("id").maybeSingle();
    if (insErr) return json({ error: `db: ${insErr.message}` }, 500);

    return json({ ok: true, id: row?.id, path });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
