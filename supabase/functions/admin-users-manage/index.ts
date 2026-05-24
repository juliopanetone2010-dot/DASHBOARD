// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type Action =
  | "list"
  | "create"
  | "update"
  | "delete"
  | "reset_password"
  | "set_permissions"
  | "set_site_access"
  | "list_audit";

const PERM_COLS = [
  "can_view_dashboard","can_sync","can_edit_rules","can_run_automation",
  "can_pause_campaigns","can_scale_campaigns","can_view_revenue","can_view_profit",
  "can_manage_push","can_manage_users","can_use_migration","can_use_funil",
  "can_use_geo_expansion","can_use_placements_cleanup","can_edit_budgets",
  "can_edit_cpa","can_view_logs",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const jwt = auth.slice(7);

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
    const { data: claimsData, error: claimsErr } = await userClient.auth.getClaims(jwt);
    if (claimsErr || !claimsData?.claims?.sub) return json({ error: "Unauthorized" }, 401);
    const callerId = claimsData.claims.sub as string;
    const callerEmail = (claimsData.claims as any).email as string | undefined;

    const admin = createClient(url, serviceKey);

    // Verifica super_admin OR can_manage_users
    const { data: profile } = await admin
      .from("admin_profiles").select("role,is_active").eq("user_id", callerId).maybeSingle();
    const isSuper = profile?.role === "super_admin" && profile?.is_active;
    const { data: perms } = await admin
      .from("admin_permissions").select("can_manage_users").eq("user_id", callerId).maybeSingle();
    const canManage = isSuper || !!perms?.can_manage_users;
    if (!canManage) return json({ error: "Forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const action: Action = body.action;

    const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? null;
    const ua = req.headers.get("user-agent") ?? null;

    const audit = async (entry: Record<string, unknown>) => {
      await admin.from("admin_audit_logs").insert({
        user_id: callerId,
        user_email: callerEmail ?? null,
        ip, user_agent: ua,
        ...entry,
      });
    };

    if (action === "list") {
      const { data: profiles } = await admin
        .from("admin_profiles")
        .select("user_id,name,role,is_active,last_login_at,created_at,created_by")
        .order("created_at", { ascending: false });
      const { data: permsAll } = await admin.from("admin_permissions").select("*");
      const { data: sitesAll } = await admin.from("admin_site_access").select("user_id,site_id");
      const { data: usersList } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const emailById = new Map(usersList?.users.map((u) => [u.id, u.email]) ?? []);
      const lastSignInById = new Map(usersList?.users.map((u) => [u.id, u.last_sign_in_at]) ?? []);
      const rows = (profiles ?? []).map((p) => ({
        ...p,
        email: emailById.get(p.user_id) ?? null,
        last_login_at: p.last_login_at ?? lastSignInById.get(p.user_id) ?? null,
        permissions: permsAll?.find((x) => x.user_id === p.user_id) ?? null,
        site_ids: (sitesAll ?? []).filter((s) => s.user_id === p.user_id).map((s) => s.site_id),
      }));
      return json({ users: rows });
    }

    if (action === "create") {
      const { email, password, name, role, site_ids, permissions: newPerms } = body;
      if (!email || !password) return json({ error: "email/password required" }, 400);
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { display_name: name ?? null },
      });
      if (cErr || !created.user) return json({ error: cErr?.message ?? "create failed" }, 400);
      const uid = created.user.id;
      await admin.from("admin_profiles").upsert({
        user_id: uid, name: name ?? null, role: role ?? "viewer", is_active: true, created_by: callerId,
      });
      if (newPerms && typeof newPerms === "object") {
        const cleaned: Record<string, boolean> = { user_id: uid as any };
        for (const k of PERM_COLS) cleaned[k] = !!newPerms[k];
        await admin.from("admin_permissions").upsert(cleaned as any);
      }
      if (Array.isArray(site_ids)) {
        await admin.from("admin_site_access").delete().eq("user_id", uid);
        if (site_ids.length) {
          await admin.from("admin_site_access").insert(site_ids.map((sid: string) => ({ user_id: uid, site_id: sid })));
        }
      }
      await audit({ action: "user.create", resource_type: "user", resource_id: uid, after: { email, role, site_ids } });
      return json({ ok: true, user_id: uid });
    }

    if (action === "update") {
      const { user_id, name, role, is_active } = body;
      if (!user_id) return json({ error: "user_id required" }, 400);
      const { data: before } = await admin.from("admin_profiles").select("*").eq("user_id", user_id).maybeSingle();
      const patch: Record<string, unknown> = {};
      if (name !== undefined) patch.name = name;
      if (role !== undefined) patch.role = role;
      if (is_active !== undefined) patch.is_active = is_active;
      await admin.from("admin_profiles").update(patch).eq("user_id", user_id);
      await audit({ action: "user.update", resource_type: "user", resource_id: user_id, before, after: patch });
      return json({ ok: true });
    }

    if (action === "set_permissions") {
      const { user_id, permissions: newPerms } = body;
      if (!user_id || !newPerms) return json({ error: "user_id/permissions required" }, 400);
      const cleaned: Record<string, unknown> = { user_id };
      for (const k of PERM_COLS) cleaned[k] = !!newPerms[k];
      const { data: before } = await admin.from("admin_permissions").select("*").eq("user_id", user_id).maybeSingle();
      await admin.from("admin_permissions").upsert(cleaned);
      await audit({ action: "user.set_permissions", resource_type: "user", resource_id: user_id, before, after: cleaned });
      return json({ ok: true });
    }

    if (action === "set_site_access") {
      const { user_id, site_ids } = body;
      if (!user_id || !Array.isArray(site_ids)) return json({ error: "user_id/site_ids required" }, 400);
      const { data: before } = await admin.from("admin_site_access").select("site_id").eq("user_id", user_id);
      await admin.from("admin_site_access").delete().eq("user_id", user_id);
      if (site_ids.length) {
        await admin.from("admin_site_access").insert(site_ids.map((sid: string) => ({ user_id, site_id: sid })));
      }
      await audit({
        action: "user.set_site_access", resource_type: "user", resource_id: user_id,
        before: { site_ids: before?.map((b: any) => b.site_id) ?? [] }, after: { site_ids },
      });
      return json({ ok: true });
    }

    if (action === "reset_password") {
      const { email } = body;
      if (!email) return json({ error: "email required" }, 400);
      const redirectTo = body.redirect_to ?? null;
      const { error: rErr } = await admin.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined);
      if (rErr) return json({ error: rErr.message }, 400);
      await audit({ action: "user.reset_password", resource_type: "user", resource_id: email });
      return json({ ok: true });
    }

    if (action === "delete") {
      const { user_id } = body;
      if (!user_id) return json({ error: "user_id required" }, 400);
      if (user_id === callerId) return json({ error: "Cannot delete yourself" }, 400);
      await admin.from("admin_site_access").delete().eq("user_id", user_id);
      await admin.from("admin_permissions").delete().eq("user_id", user_id);
      await admin.from("admin_profiles").delete().eq("user_id", user_id);
      const { error: dErr } = await admin.auth.admin.deleteUser(user_id);
      if (dErr) return json({ error: dErr.message }, 400);
      await audit({ action: "user.delete", resource_type: "user", resource_id: user_id });
      return json({ ok: true });
    }

    if (action === "list_audit") {
      const limit = Math.min(Number(body.limit) || 200, 1000);
      const { data: logs } = await admin
        .from("admin_audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      return json({ logs });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("admin-users-manage error", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
