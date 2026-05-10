// Guest login: validates fixed guest credentials and returns a session
// for the OWNER user, so the guest sees the owner's data via RLS.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

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

    // Get the owner's email to generate a magic link for
    const { data: ownerData, error: ownerErr } = await admin.auth.admin.getUserById(ownerUserId);
    if (ownerErr || !ownerData?.user?.email) {
      console.error("[guest-login] owner lookup failed", ownerErr);
      return json({ error: "Owner não encontrado" }, 500);
    }

    // Generate a magic link for the owner; we'll convert it to a session
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: ownerData.user.email,
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
