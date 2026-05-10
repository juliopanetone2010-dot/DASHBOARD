// Guest login: validates fixed guest credentials and returns a session
// for the OWNER user, so the guest sees the owner's data via RLS.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const DEFAULT_OWNER_USER_ID = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body?.email === "string" ? body.email : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const guestEmail = Deno.env.get("GUEST_LOGIN_EMAIL");
    const guestPassword = Deno.env.get("GUEST_LOGIN_PASSWORD");
    const ownerUserId = Deno.env.get("GUEST_OWNER_USER_ID");

    if (!guestEmail || !guestPassword || !ownerUserId) {
      return json({ error: "Guest login não configurado" }, 500);
    }

    // Allow two modes:
    // 1) Empty body => button "Entrar como convidado" uses fixed server-side creds
    // 2) Body with email/password => must match the guest creds exactly
    const useFixed = !email && !password;
    const matches =
      email.trim().toLowerCase() === guestEmail.trim().toLowerCase() &&
      password === guestPassword;

    if (!useFixed && !matches) {
      return json({ error: "Credenciais inválidas" }, 401);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve owner: accept UUID or email in GUEST_OWNER_USER_ID
    const configuredOwner = ownerUserId.trim().replace(/^["']|["']$/g, "");
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const raw = uuidRe.test(configuredOwner) || configuredOwner.includes("@")
      ? configuredOwner
      : DEFAULT_OWNER_USER_ID;
    if (raw !== configuredOwner) {
      console.warn("[guest-login] GUEST_OWNER_USER_ID inválido; usando owner padrão configurado no código");
    }
    let ownerEmail: string | null = null;
    if (uuidRe.test(raw)) {
      const { data: ownerData, error: ownerErr } = await admin.auth.admin.getUserById(raw);
      if (ownerErr || !ownerData?.user?.email) {
        console.error("[guest-login] owner lookup by id failed", ownerErr);
        return json({ error: "Owner não encontrado" }, 500);
      }
      ownerEmail = ownerData.user.email;
    } else if (raw.includes("@")) {
      ownerEmail = raw;
    } else {
      console.error("[guest-login] GUEST_OWNER_USER_ID inválido (não é UUID nem email):", raw);
      return json({ error: "GUEST_OWNER_USER_ID deve ser UUID ou email" }, 500);
    }

    // Generate a magic link for the owner; we'll convert it to a session
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: ownerEmail!,
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error("[guest-login] generateLink failed", linkErr);
      return json({ error: "Falha ao gerar acesso" }, 500);
    }

    // Verify the OTP server-side to obtain a session
    const anon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    });
    if (verifyErr || !verifyData?.session) {
      console.error("[guest-login] verifyOtp failed", verifyErr);
      return json({ error: "Falha ao criar sessão" }, 500);
    }

    return json({
      access_token: verifyData.session.access_token,
      refresh_token: verifyData.session.refresh_token,
    });
  } catch (e) {
    console.error("[guest-login] error", e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
