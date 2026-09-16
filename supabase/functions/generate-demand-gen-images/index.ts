// Gera imagens via OpenAI (gpt-image-1), corta pras 3 proporções que o Google Ads
// Demand Gen exige (1.91:1, 1:1, 4:5) e sobe cada uma como Asset de imagem na conta
// Google Ads escolhida. NÃO anexa a nenhum anúncio/campanha sozinho — só deixa os
// assets prontos na conta pra você revisar e usar (aqui ou na Migração).
//
// Precisa do secret OPENAI_API_KEY configurado (Supabase → Edge Functions → Secrets).
// Custo da geração é cobrado na SUA conta OpenAI, não tem nada a ver com o Supabase.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getAccessTokenFor, devTokenFor } from "../_shared/google_api_set.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Especificações do Demand Gen: tamanho pedido na geração (o mais próximo que o
// gpt-image-1 suporta) + a proporção EXATA que o Google Ads exige (ele recusa fora
// da tolerância). Cortamos no centro depois de gerar pra bater exato.
const SPECS = [
  { key: "landscape_1_91_1", label: "Paisagem 1.91:1 (marketing image)", genSize: "1536x1024", ratio: 1.91 },
  { key: "square_1_1", label: "Quadrado 1:1", genSize: "1024x1024", ratio: 1 },
  { key: "portrait_4_5", label: "Retrato 4:5", genSize: "1024x1536", ratio: 0.8 },
] as const;

function cropToRatio(img: InstanceType<typeof Image>, targetRatio: number) {
  const w = img.width, h = img.height;
  const currentRatio = w / h;
  if (Math.abs(currentRatio - targetRatio) < 0.005) return img;
  if (currentRatio > targetRatio) {
    // imagem mais larga que o alvo — corta as laterais
    const newW = Math.max(1, Math.round(h * targetRatio));
    const x = Math.round((w - newW) / 2);
    return img.crop(x, 0, newW, h);
  }
  // imagem mais alta que o alvo — corta em cima/embaixo
  const newH = Math.max(1, Math.round(w / targetRatio));
  const y = Math.round((h - newH) / 2);
  return img.crop(0, y, w, newH);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const prompt = String((body as any)?.prompt ?? "").trim();
    const accountId = String((body as any)?.google_account_id ?? "").trim();
    if (!prompt) return json({ error: "prompt obrigatório" });
    if (!accountId) return json({ error: "google_account_id obrigatório" });

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) return json({ error: "OPENAI_API_KEY não configurada (Supabase → Edge Functions → Secrets)" });

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: acc, error: accErr } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id, api_set")
      .eq("id", accountId)
      .eq("user_id", userId)
      .maybeSingle();
    if (accErr) return json({ error: accErr.message });
    if (!acc?.refresh_token) return json({ error: "Conta Google Ads não encontrada ou sem token" });

    const apiSet = acc.api_set ?? 1;
    const accessToken = await getAccessTokenFor(acc.refresh_token, apiSet);
    const adsHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": devTokenFor(apiSet),
      "Content-Type": "application/json",
    };
    if (acc.login_customer_id) adsHeaders["login-customer-id"] = acc.login_customer_id;

    // Gera + recorta + sobe as 3 variantes em paralelo — uma falhando não trava as outras.
    const results = await Promise.all(SPECS.map(async (spec) => {
      try {
        const genRes = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-image-1", prompt, size: spec.genSize, n: 1 }),
        });
        const genJson = await genRes.json();
        if (!genRes.ok) return { key: spec.key, label: spec.label, ok: false, error: genJson?.error?.message ?? JSON.stringify(genJson).slice(0, 300) };
        const b64 = genJson?.data?.[0]?.b64_json;
        if (!b64) return { key: spec.key, label: spec.label, ok: false, error: "OpenAI não retornou imagem" };

        const decoded = await Image.decode(base64ToBytes(b64));
        const cropped = cropToRatio(decoded, spec.ratio);
        const outBytes = await cropped.encode(); // PNG
        const outB64 = bytesToBase64(outBytes);

        const assetRes = await fetch(`https://googleads.googleapis.com/v24/customers/${acc.customer_id}/assets:mutate`, {
          method: "POST",
          headers: adsHeaders,
          body: JSON.stringify({
            operations: [{ create: { name: `ai-${spec.key}-${Date.now()}`, type: "IMAGE", imageAsset: { data: outB64 } } }],
          }),
        });
        const assetJson = await assetRes.json();
        const resourceName = assetJson?.results?.[0]?.resourceName;
        if (!assetRes.ok || !resourceName) {
          return { key: spec.key, label: spec.label, ok: false, error: assetJson?.error?.message ?? JSON.stringify(assetJson).slice(0, 300) };
        }
        return {
          key: spec.key, label: spec.label, ok: true,
          asset_resource_name: resourceName,
          width: cropped.width, height: cropped.height,
          preview_base64: outB64, // dataURL pro front mostrar preview: `data:image/png;base64,${preview_base64}`
        };
      } catch (e) {
        return { key: spec.key, label: spec.label, ok: false, error: String(e instanceof Error ? e.message : e) };
      }
    }));

    const succeeded = results.filter((r) => r.ok).length;
    return json({
      ok: true,
      prompt,
      customer_id: acc.customer_id,
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  } catch (e) {
    console.error("[generate-demand-gen-images]", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});
