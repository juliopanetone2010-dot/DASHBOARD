// Admin Users management — only callable by super admins.
// Actions:
//   - list: lista todos os usuários com role/status
//   - invite: cria novo usuário via auth.admin (envia email com senha temporária)
//   - update_profile: ativa/desativa, muda role e nome
//   - reset_password: envia email de recovery
//   - set_site_access: define lista de site_ids permitidos
//   - set_module_perms: define permissões por módulo
//   - set_ga_perms: define permissões de contas Google Ads
//   - set_permissions: atualiza flags em admin_permissions
//   - delete: remove usuário do sistema (auth + admin_profiles)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResp({ error: "Login obrigatório" }, 401);
    }

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const callerId = claims?.claims?.sub as string | undefined;
    if (!callerId) return jsonResp({ error: "Token inválido" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: superData } = await admin.rpc("is_super_admin", { _uid: callerId });
    if (!superData) {
      return jsonResp({ error: "Acesso negado: requer super admin" }, 403);
    }

    const body = await req.json().catch(() => ({} as any));
    const action = String(body.action ?? "");

    switch (action) {
      case "list": return await listUsers(admin);
      case "invite": return await inviteUser(admin, body, callerId);
      case "update_profile": return await updateProfile(admin, body, callerId);
      case "reset_password": return await resetPassword(admin, body);
      case "set_password": return await setPassword(admin, body, callerId);
      case "set_site_access": return await setSiteAccess(admin, body, callerId);
      case "set_module_perms": return await setModulePerms(admin, body, callerId);
      case "set_ga_perms": return await setGaPerms(admin, body, callerId);
      case "set_permissions": return await setPermissions(admin, body, callerId);
      case "delete": return await deleteUser(admin, body, callerId);
      default:
        return jsonResp({ error: `Ação desconhecida: ${action}` }, 400);
    }
  } catch (e) {
    console.error("[admin-users] uncaught", e);
    return jsonResp({ error: String(e) }, 500);
  }
});

function jsonResp(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function listUsers(admin: any) {
  // Lista todos os auth.users (paginado, primeira página).
  const { data: usersData, error: usersErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (usersErr) return jsonResp({ error: usersErr.message }, 500);
  const users = (usersData?.users ?? []) as any[];

  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) return jsonResp({ users: [] });

  const [{ data: profiles }, { data: perms }, { data: siteAccess }, { data: modulePerms }, { data: gaPerms }] =
    await Promise.all([
      admin.from("admin_profiles").select("*").in("user_id", userIds),
      admin.from("admin_permissions").select("*").in("user_id", userIds),
      admin.from("admin_site_access").select("*").in("user_id", userIds),
      admin.from("admin_module_permissions").select("*").in("user_id", userIds),
      admin.from("admin_google_ads_permissions").select("*").in("user_id", userIds),
    ]);

  const byUser = (rows: any[] | null, key = "user_id") =>
    (rows ?? []).reduce<Record<string, any[]>>((acc, r) => {
      (acc[r[key]] = acc[r[key]] || []).push(r);
      return acc;
    }, {});

  const profMap = (profiles ?? []).reduce<Record<string, any>>((a, p) => { a[p.user_id] = p; return a; }, {});
  const permMap = (perms ?? []).reduce<Record<string, any>>((a, p) => { a[p.user_id] = p; return a; }, {});
  const siteMap = byUser(siteAccess);
  const modMap = byUser(modulePerms);
  const gaMap = byUser(gaPerms);

  return jsonResp({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      profile: profMap[u.id] ?? null,
      permissions: permMap[u.id] ?? null,
      site_access: siteMap[u.id] ?? [],
      module_permissions: modMap[u.id] ?? [],
      google_ads_permissions: gaMap[u.id] ?? [],
    })),
  });
}

async function inviteUser(admin: any, body: any, callerId: string) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = (body.role as string) ?? "viewer";
  const name = (body.name as string) ?? email.split("@")[0];
  const providedPassword = typeof body.password === "string" && body.password.length >= 8 ? body.password : null;
  if (!email.includes("@")) return jsonResp({ error: "Email inválido" }, 400);

  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = (existing?.users ?? []).find((u: any) => (u.email ?? "").toLowerCase() === email);
  let userId = found?.id as string | undefined;
  let finalPassword: string | null = providedPassword;

  if (!userId) {
    if (!finalPassword) finalPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: finalPassword,
      email_confirm: true,
      user_metadata: { display_name: name },
    });
    if (createErr) return jsonResp({ error: createErr.message }, 400);
    userId = created.user?.id;
  } else if (finalPassword) {
    await admin.auth.admin.updateUserById(userId, { password: finalPassword, email_confirm: true });
  }

  if (!userId) return jsonResp({ error: "Falha ao criar usuário" }, 500);

  await admin.from("admin_profiles").upsert({
    user_id: userId,
    name,
    role,
    is_active: true,
    created_by: callerId,
  }, { onConflict: "user_id" });

  await admin.from("admin_permissions").upsert({
    user_id: userId,
    can_view_dashboard: true,
  }, { onConflict: "user_id" });

  await logAudit(admin, callerId, "invite_user", { resource_id: userId, after: { email, role, name, password_set: !!providedPassword } });

  return jsonResp({ ok: true, user_id: userId, password: finalPassword });
}

async function setPassword(admin: any, body: any, callerId: string) {
  const userId = String(body.user_id ?? "");
  const password = String(body.password ?? "");
  if (!userId) return jsonResp({ error: "user_id obrigatório" }, 400);
  if (password.length < 8) return jsonResp({ error: "Senha deve ter ao menos 8 caracteres" }, 400);
  const { error } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
  if (error) return jsonResp({ error: error.message }, 400);
  await logAudit(admin, callerId, "set_password", { resource_id: userId });
  return jsonResp({ ok: true });
}

async function updateProfile(admin: any, body: any, callerId: string) {
  const userId = String(body.user_id ?? "");
  if (!userId) return jsonResp({ error: "user_id obrigatório" }, 400);
  const patch: Record<string, unknown> = {};
  if (typeof body.role === "string") patch.role = body.role;
  if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
  if (typeof body.name === "string") patch.name = body.name;
  if (Object.keys(patch).length === 0) return jsonResp({ ok: true });

  const { error } = await admin.from("admin_profiles").update(patch).eq("user_id", userId);
  if (error) return jsonResp({ error: error.message }, 400);
  await logAudit(admin, callerId, "update_profile", { resource_id: userId, after: patch });
  return jsonResp({ ok: true });
}

async function resetPassword(admin: any, body: any) {
  const email = String(body.email ?? "");
  if (!email) return jsonResp({ error: "email obrigatório" }, 400);
  const { error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  if (error) return jsonResp({ error: error.message }, 400);
  return jsonResp({ ok: true });
}

async function setSiteAccess(admin: any, body: any, callerId: string) {
  const userId = String(body.user_id ?? "");
  const siteIds = (body.site_ids ?? []) as string[];
  if (!userId) return jsonResp({ error: "user_id obrigatório" }, 400);

  // Make sure the user has a profile so the UI doesn't render them as "inactive".
  const { data: prof } = await admin.from("admin_profiles").select("user_id").eq("user_id", userId).maybeSingle();
  if (!prof) {
    const { data: u } = await admin.auth.admin.getUserById(userId);
    await admin.from("admin_profiles").upsert({
      user_id: userId,
      name: (u?.user?.email ?? "").split("@")[0] || "user",
      role: "viewer",
      is_active: true,
    }, { onConflict: "user_id" });
    await admin.from("admin_permissions").upsert(
      { user_id: userId, can_view_dashboard: true },
      { onConflict: "user_id" },
    );
  }

  await admin.from("admin_site_access").delete().eq("user_id", userId);
  if (siteIds.length > 0) {
    await admin.from("admin_site_access").insert(
      siteIds.map((sid) => ({ user_id: userId, site_id: sid })),
    );
  }

  // Auto-grant Google Ads access (view + sync) for all accounts linked to the granted sites.
  // Preserve existing migrate flag where present; do NOT remove permissions for accounts
  // linked to sites the user still has access to.
  const { data: links } = siteIds.length > 0
    ? await admin.from("account_site_links").select("google_account_id").in("site_id", siteIds)
    : { data: [] as Array<{ google_account_id: string }> };
  const accountIds = Array.from(new Set((links ?? []).map((l: any) => l.google_account_id).filter(Boolean)));

  if (accountIds.length > 0) {
    const { data: existing } = await admin
      .from("admin_google_ads_permissions")
      .select("google_account_id, can_migrate")
      .eq("user_id", userId)
      .in("google_account_id", accountIds);
    const migrateMap = new Map<string, boolean>((existing ?? []).map((r: any) => [r.google_account_id, !!r.can_migrate]));
    await admin.from("admin_google_ads_permissions").upsert(
      accountIds.map((aid) => ({
        user_id: userId,
        google_account_id: aid,
        can_view: true,
        can_sync: true,
        can_migrate: migrateMap.get(aid) ?? false,
      })),
      { onConflict: "user_id,google_account_id" },
    );
  }

  await logAudit(admin, callerId, "set_site_access", {
    resource_id: userId,
    after: { site_ids: siteIds, auto_granted_accounts: accountIds },
  });
  return jsonResp({ ok: true });
}

async function setModulePerms(admin: any, body: any, callerId: string) {
  const userId = String(body.user_id ?? "");
  const perms = (body.permissions ?? []) as Array<{ module: string; can_access: boolean; can_edit: boolean }>;
  if (!userId) return jsonResp({ error: "user_id obrigatório" }, 400);
  await admin.from("admin_module_permissions").delete().eq("user_id", userId);
  if (perms.length > 0) {
    await admin.from("admin_module_permissions").insert(
      perms.map((p) => ({ user_id: userId, module: p.module, can_access: !!p.can_access, can_edit: !!p.can_edit })),
    );
  }
  await logAudit(admin, callerId, "set_module_perms", { resource_id: userId, after: { perms } });
  return jsonResp({ ok: true });
}

async function setGaPerms(admin: any, body: any, callerId: string) {
  const userId = String(body.user_id ?? "");
  const perms = (body.permissions ?? []) as Array<{ google_account_id: string; can_view: boolean; can_sync: boolean; can_migrate: boolean }>;
  if (!userId) return jsonResp({ error: "user_id obrigatório" }, 400);
  await admin.from("admin_google_ads_permissions").delete().eq("user_id", userId);
  if (perms.length > 0) {
    await admin.from("admin_google_ads_permissions").insert(
      perms.map((p) => ({
        user_id: userId,
        google_account_id: p.google_account_id,
        can_view: !!p.can_view,
        can_sync: !!p.can_sync,
        can_migrate: !!p.can_migrate,
      })),
    );
  }
  await logAudit(admin, callerId, "set_ga_perms", { resource_id: userId, after: { perms } });
  return jsonResp({ ok: true });
}

async function setPermissions(admin: any, body: any, callerId: string) {
  const userId = String(body.user_id ?? "");
  const flags = (body.flags ?? {}) as Record<string, boolean>;
  if (!userId) return jsonResp({ error: "user_id obrigatório" }, 400);
  await admin.from("admin_permissions").upsert({ user_id: userId, ...flags }, { onConflict: "user_id" });
  await logAudit(admin, callerId, "set_permissions", { resource_id: userId, after: flags });
  return jsonResp({ ok: true });
}

async function deleteUser(admin: any, body: any, callerId: string) {
  const userId = String(body.user_id ?? "");
  if (!userId) return jsonResp({ error: "user_id obrigatório" }, 400);
  if (userId === callerId) return jsonResp({ error: "Você não pode deletar a si mesmo" }, 400);
  await admin.from("admin_profiles").delete().eq("user_id", userId);
  await admin.from("admin_permissions").delete().eq("user_id", userId);
  await admin.from("admin_site_access").delete().eq("user_id", userId);
  await admin.from("admin_module_permissions").delete().eq("user_id", userId);
  await admin.from("admin_google_ads_permissions").delete().eq("user_id", userId);
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return jsonResp({ error: error.message }, 400);
  await logAudit(admin, callerId, "delete_user", { resource_id: userId });
  return jsonResp({ ok: true });
}

async function logAudit(admin: any, userId: string, action: string, extra: Record<string, unknown>) {
  try {
    await admin.from("admin_audit_logs").insert({ user_id: userId, action, ...extra });
  } catch (e) {
    console.error("[admin-users] audit log failed", e);
  }
}
