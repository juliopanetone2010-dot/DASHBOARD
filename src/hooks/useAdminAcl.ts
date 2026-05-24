import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

export type AppRole =
  | "super_admin"
  | "admin"
  | "media_buyer"
  | "adops"
  | "viewer"
  | "site_manager";

export const PERMISSION_KEYS = [
  "can_view_dashboard",
  "can_sync",
  "can_edit_rules",
  "can_run_automation",
  "can_pause_campaigns",
  "can_scale_campaigns",
  "can_view_revenue",
  "can_view_profit",
  "can_manage_push",
  "can_manage_users",
  "can_use_migration",
  "can_use_funil",
  "can_use_geo_expansion",
  "can_use_placements_cleanup",
  "can_edit_budgets",
  "can_edit_cpa",
  "can_view_logs",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export interface AdminAcl {
  loading: boolean;
  role: AppRole | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  permissions: Record<PermissionKey, boolean>;
  allowedSiteIds: Set<string>;
  can: (perm: PermissionKey) => boolean;
  canAccessSite: (siteId: string) => boolean;
}

const EMPTY_PERMS = PERMISSION_KEYS.reduce(
  (acc, k) => ({ ...acc, [k]: false }),
  {} as Record<PermissionKey, boolean>,
);

export function useAdminAcl(): AdminAcl {
  const { user } = useAuth();
  const userId = user?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["admin-acl", userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async () => {
      const [profileRes, permsRes, sitesRes] = await Promise.all([
        supabase.from("admin_profiles").select("role,is_active").eq("user_id", userId!).maybeSingle(),
        supabase.from("admin_permissions").select("*").eq("user_id", userId!).maybeSingle(),
        supabase.from("admin_site_access").select("site_id").eq("user_id", userId!),
      ]);
      const role = (profileRes.data?.role as AppRole | undefined) ?? null;
      const isActive = !!profileRes.data?.is_active;
      const perms = { ...EMPTY_PERMS };
      if (permsRes.data) {
        for (const k of PERMISSION_KEYS) {
          perms[k] = !!(permsRes.data as Record<string, unknown>)[k];
        }
      }
      const allowed = new Set<string>((sitesRes.data ?? []).map((r: { site_id: string }) => r.site_id));
      return { role, isActive, perms, allowed };
    },
  });

  const isSuperAdmin = data?.role === "super_admin" && !!data?.isActive;
  const allowedSiteIds = data?.allowed ?? new Set<string>();
  const permissions = data?.perms ?? EMPTY_PERMS;

  return {
    loading: isLoading,
    role: data?.role ?? null,
    isActive: !!data?.isActive,
    isSuperAdmin,
    permissions,
    allowedSiteIds,
    can: (perm) => isSuperAdmin || !!permissions[perm],
    canAccessSite: (siteId) => isSuperAdmin || allowedSiteIds.has(siteId),
  };
}
