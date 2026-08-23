// RBAC guards reutilizáveis para edge functions.
// Uso típico:
//
//   import { requireUser, requireSiteAccess } from "../_shared/rbac.ts";
//   const { userId, admin } = await requireUser(req);
//   await requireSiteAccess(admin, userId, siteId);
//
// Lança erros HTTP-style; chame dentro de try/catch e devolva 401/403.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getAdminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

export async function requireUser(req: Request): Promise<{ userId: string; admin: SupabaseClient }> {
  const authHeader = req.headers.get("Authorization");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  
  // BYPASS FOR SERVICE ROLE (used in repairs/syncs)
  if (serviceRoleKey && authHeader?.includes(serviceRoleKey)) {
    const bodyText = await req.clone().text().catch(() => "");
    let userId: string | undefined;
    try {
      const body = JSON.parse(bodyText);
      userId = body.user_id;
    } catch (_) {}
    
    if (userId) {
      console.log(`[rbac] Bypassing auth via service role for userId: ${userId}`);
      return { userId, admin: getAdminClient() };
    }
  }

  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Login obrigatório");
  }
  const token = authHeader.replace("Bearer ", "");
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  const { data, error } = await userClient.auth.getClaims(token);
  const userId = data?.claims?.sub as string | undefined;
  if (error || !userId) throw new HttpError(401, "Token inválido");
  return { userId, admin: getAdminClient() };
}

export async function isSuperAdmin(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("is_super_admin", { _uid: userId });
  if (error) return false;
  return !!data;
}

export async function requireSuperAdmin(admin: SupabaseClient, userId: string): Promise<void> {
  if (!(await isSuperAdmin(admin, userId))) {
    throw new HttpError(403, "Acesso negado: requer super admin");
  }
}

export async function canAccessSite(admin: SupabaseClient, userId: string, siteId: string): Promise<boolean> {
  if (!siteId) return false;
  const { data, error } = await admin.rpc("can_access_site", { _uid: userId, _site_id: siteId });
  if (error) return false;
  return !!data;
}

export async function requireSiteAccess(admin: SupabaseClient, userId: string, siteId: string): Promise<void> {
  if (!(await canAccessSite(admin, userId, siteId))) {
    throw new HttpError(403, `Acesso negado ao site ${siteId}`);
  }
}

export async function canAccessAccount(
  admin: SupabaseClient,
  userId: string,
  accountId: string,
  opts?: { needSync?: boolean; needMigrate?: boolean },
): Promise<boolean> {
  if (!accountId) return false;
  const { data, error } = await admin.rpc("can_access_google_account", {
    _uid: userId,
    _account_id: accountId,
    _need_sync: opts?.needSync ?? false,
    _need_migrate: opts?.needMigrate ?? false,
  });
  if (error) return false;
  return !!data;
}

export async function requireAccountAccess(
  admin: SupabaseClient,
  userId: string,
  accountId: string,
  opts?: { needSync?: boolean; needMigrate?: boolean },
): Promise<void> {
  if (!(await canAccessAccount(admin, userId, accountId, opts))) {
    throw new HttpError(403, `Acesso negado à conta ${accountId}`);
  }
}

export async function canAccessModule(
  admin: SupabaseClient,
  userId: string,
  module: string,
  needEdit = false,
): Promise<boolean> {
  const { data, error } = await admin.rpc("can_access_module", {
    _uid: userId,
    _module: module,
    _need_edit: needEdit,
  });
  if (error) return false;
  return !!data;
}

export async function requireModule(
  admin: SupabaseClient,
  userId: string,
  module: string,
  needEdit = false,
): Promise<void> {
  if (!(await canAccessModule(admin, userId, module, needEdit))) {
    throw new HttpError(403, `Sem permissão para o módulo ${module}`);
  }
}

export async function accessibleSites(admin: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await admin.rpc("accessible_sites", { _uid: userId });
  if (error || !data) return [];
  return (data as Array<{ accessible_sites: string } | string>).map((r: any) =>
    typeof r === "string" ? r : (r.accessible_sites ?? r)
  );
}

export async function effectiveRole(admin: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await admin.rpc("effective_role", { _uid: userId });
  if (error) return "viewer";
  return (data as string) ?? "viewer";
}

// Helper: converte HttpError em Response JSON pronta.
export function errorResponse(e: unknown, corsHeaders: Record<string, string>): Response {
  if (e instanceof HttpError) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  console.error("[rbac] uncaught", e);
  return new Response(JSON.stringify({ error: String(e) }), {
    status: 500,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function logAdminAction(
  admin: SupabaseClient,
  args: {
    userId: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    campaignId?: string;
    siteId?: string;
    before?: unknown;
    after?: unknown;
    userEmail?: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<void> {
  try {
    await admin.from("admin_audit_logs").insert({
      user_id: args.userId,
      action: args.action,
      resource_type: args.resourceType ?? null,
      resource_id: args.resourceId ?? null,
      campaign_id: args.campaignId ?? null,
      site_id: args.siteId ?? null,
      before: args.before ? JSON.parse(JSON.stringify(args.before)) : null,
      after: args.after ? JSON.parse(JSON.stringify(args.after)) : null,
      user_email: args.userEmail ?? null,
      ip: args.ip ?? null,
      user_agent: args.userAgent ?? null,
    });
  } catch (e) {
    console.error("[rbac] audit log failed", e);
  }
}
