// CRUD + teste de conexão para providers de IA externos.
// API keys são criptografadas com AES-GCM antes de salvar. Nunca retornadas em claro.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { encryptApiKey, decryptApiKey, maskApiKey } from "../_shared/ai-provider-crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPPORTED = new Set(["deepseek", "openai", "openrouter", "claude", "gemini"]);
// Apenas providers OpenAI-compatible são roteáveis hoje:
const OPENAI_COMPATIBLE = new Set(["deepseek", "openai", "openrouter"]);

const DEFAULT_BASE_URL: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  claude: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

const DEFAULT_MODEL: Record<string, string> = {
  deepseek: "deepseek-chat",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
  claude: "claude-3-5-sonnet-latest",
  gemini: "gemini-2.0-flash",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sanitize(row: any) {
  if (!row) return row;
  const { api_key_encrypted, api_key_iv, ...rest } = row;
  return { ...rest, has_api_key: Boolean(api_key_encrypted) };
}

async function testProvider(provider: string, apiKey: string, baseUrl: string, model: string) {
  const t0 = Date.now();
  try {
    if (OPENAI_COMPATIBLE.has(provider)) {
      const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
        }),
      });
      const latency = Date.now() - t0;
      if (!r.ok) {
        const txt = await r.text();
        return { ok: false, latency_ms: latency, error: `${r.status}: ${txt.slice(0, 300)}`, model };
      }
      const j = await r.json();
      return { ok: true, latency_ms: latency, model: j?.model ?? model };
    }
    if (provider === "claude") {
      const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
      });
      const latency = Date.now() - t0;
      if (!r.ok) return { ok: false, latency_ms: latency, error: `${r.status}: ${(await r.text()).slice(0, 300)}`, model };
      return { ok: true, latency_ms: latency, model };
    }
    if (provider === "gemini") {
      const r = await fetch(
        `${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] }),
        },
      );
      const latency = Date.now() - t0;
      if (!r.ok) return { ok: false, latency_ms: latency, error: `${r.status}: ${(await r.text()).slice(0, 300)}`, model };
      return { ok: true, latency_ms: latency, model };
    }
    return { ok: false, latency_ms: 0, error: `unsupported provider ${provider}`, model };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e), model };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "list");

    if (action === "list") {
      const { data, error } = await admin
        .from("ai_provider_configs").select("*").eq("user_id", user.id).order("provider");
      if (error) return json({ error: error.message }, 500);
      return json({ items: (data ?? []).map(sanitize) });
    }

    if (action === "save") {
      const provider = String(body?.provider ?? "");
      if (!SUPPORTED.has(provider)) return json({ error: "unsupported provider" }, 400);
      const model = String(body?.model ?? DEFAULT_MODEL[provider] ?? "").trim() || DEFAULT_MODEL[provider];
      const baseUrl = String(body?.base_url ?? "").trim() || DEFAULT_BASE_URL[provider];
      const apiKeyRaw = typeof body?.api_key === "string" ? body.api_key.trim() : "";
      const enabled = body?.enabled !== false;

      const { data: existing } = await admin
        .from("ai_provider_configs").select("*")
        .eq("user_id", user.id).eq("provider", provider).maybeSingle();

      let cipher = existing?.api_key_encrypted ?? null;
      let iv = existing?.api_key_iv ?? null;
      if (apiKeyRaw) {
        const enc = await encryptApiKey(apiKeyRaw);
        cipher = enc.cipher; iv = enc.iv;
      }
      const payload = {
        user_id: user.id, provider, model, base_url: baseUrl,
        api_key_encrypted: cipher, api_key_iv: iv, enabled,
      };
      const { data, error } = await admin
        .from("ai_provider_configs")
        .upsert(payload, { onConflict: "user_id,provider" })
        .select("*").single();
      if (error) return json({ error: error.message }, 500);
      return json({ item: sanitize(data) });
    }

    if (action === "delete") {
      const provider = String(body?.provider ?? "");
      const { error } = await admin
        .from("ai_provider_configs").delete()
        .eq("user_id", user.id).eq("provider", provider);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "set_active") {
      const provider = String(body?.provider ?? "");
      if (!SUPPORTED.has(provider)) return json({ error: "unsupported provider" }, 400);
      // Apenas 1 ativo por usuário
      await admin.from("ai_provider_configs")
        .update({ is_active: false }).eq("user_id", user.id);
      const { data, error } = await admin
        .from("ai_provider_configs")
        .update({ is_active: true, enabled: true })
        .eq("user_id", user.id).eq("provider", provider)
        .select("*").single();
      if (error) return json({ error: error.message }, 500);
      return json({ item: sanitize(data) });
    }

    if (action === "clear_active") {
      await admin.from("ai_provider_configs")
        .update({ is_active: false }).eq("user_id", user.id);
      return json({ ok: true });
    }

    if (action === "test") {
      const provider = String(body?.provider ?? "");
      if (!SUPPORTED.has(provider)) return json({ error: "unsupported provider" }, 400);
      const { data: cfg } = await admin.from("ai_provider_configs").select("*")
        .eq("user_id", user.id).eq("provider", provider).maybeSingle();
      // Permite testar com chave nova passada no body sem persistir
      let apiKey = typeof body?.api_key === "string" && body.api_key.trim() ? body.api_key.trim() : "";
      if (!apiKey) {
        if (!cfg?.api_key_encrypted || !cfg?.api_key_iv) return json({ error: "no api key configured" }, 400);
        apiKey = await decryptApiKey(cfg.api_key_encrypted, cfg.api_key_iv);
      }
      const model = String(body?.model ?? cfg?.model ?? DEFAULT_MODEL[provider]);
      const baseUrl = String(body?.base_url ?? cfg?.base_url ?? DEFAULT_BASE_URL[provider]);
      const result = await testProvider(provider, apiKey, baseUrl, model);
      // Persist resultado se já existe config
      if (cfg) {
        await admin.from("ai_provider_configs").update({
          last_tested_at: new Date().toISOString(),
          last_test_status: result.ok ? "ok" : "error",
          last_test_latency_ms: result.latency_ms,
          last_test_error: result.ok ? null : result.error ?? null,
        }).eq("id", cfg.id);
      }
      return json({
        ok: result.ok,
        latency_ms: result.latency_ms,
        model: result.model,
        error: result.ok ? null : result.error,
        masked_key: maskApiKey(apiKey),
      });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("[ai-providers] error", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
