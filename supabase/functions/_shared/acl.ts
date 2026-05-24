// Shared ACL helper for edge functions. Validates JWT, checks granular permission
// in admin_permissions / admin_profiles, and (optionally) site access. Also logs
// privileged actions to admin_audit_logs.
//
// Usage:
//   const { userId, supabaseAdmin } = await assertPermission(req, "can_pause_campaigns");
//   await logAudit(supabaseAdmin, { user_id: userId, action: "pause_campaign", ... });
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

export class AclError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export async function getCallerUserId(req: Request): Promise<string> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) throw new AclError(401, "Login obrigatório");
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data, error } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
  if (error || !data?.claims?.sub) throw new AclError(401, "Token inválido");
  return data.claims.sub as string;
}

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export async function assertPermission(
  req: Request,
  perm: string,
): Promise<{ userId: string; supabaseAdmin: SupabaseClient }> {
  const userId = await getCallerUserId(req);
  const supabaseAdmin = adminClient();
  const { data, error } = await supabaseAdmin.rpc("admin_has_permission", {
    _uid: userId,
    _perm: perm,
  });
  if (error) throw new AclError(500, `Falha ao validar permissão: ${error.message}`);
  if (!data) throw new AclError(403, `Permissão negada: ${perm}`);
  return { userId, supabaseAdmin };
}

export async function assertSiteAccess(
  supabaseAdmin: SupabaseClient,
  userId: string,
  siteId: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("admin_has_site_access", {
    _uid: userId,
    _site: siteId,
  });
  if (error) throw new AclError(500, `Falha ao validar acesso ao site: ${error.message}`);
  if (!data) throw new AclError(403, "Sem acesso a este site");
}

export interface AuditEntry {
  user_id: string;
  action: string;
  resource_type?: string;
  resource_id?: string;
  site_id?: string | null;
  campaign_id?: string | null;
  before?: unknown;
  after?: unknown;
  user_email?: string;
}

export async function logAudit(
  supabaseAdmin: SupabaseClient,
  req: Request,
  entry: AuditEntry,
): Promise<void> {
  const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? null;
  const ua = req.headers.get("user-agent") ?? null;
  await supabaseAdmin.from("admin_audit_logs").insert({
    user_id: entry.user_id,
    user_email: entry.user_email ?? null,
    action: entry.action,
    resource_type: entry.resource_type ?? null,
    resource_id: entry.resource_id ?? null,
    site_id: entry.site_id ?? null,
    campaign_id: entry.campaign_id ?? null,
    before: (entry.before ?? null) as never,
    after: (entry.after ?? null) as never,
    ip,
    user_agent: ua,
  });
}

export function aclErrorResponse(e: unknown, corsHeaders: Record<string, string>): Response {
  if (e instanceof AclError) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
    status: 500,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
