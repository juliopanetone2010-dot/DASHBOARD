import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "super_admin" | "admin" | "manager" | "viewer";

export interface CurrentRole {
  role: AppRole;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isManager: boolean;
  isViewer: boolean;
  email: string | null;
  displayName: string | null;
}

export function useCurrentRole() {
  const { user } = useAuth();
  return useQuery<CurrentRole>({
    queryKey: ["current-role", user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data: roleData } = await supabase.rpc("effective_role", { _uid: user!.id });
      const role = ((roleData as string) ?? "viewer") as AppRole;
      const { data: superData } = await supabase.rpc("is_super_admin", { _uid: user!.id });
      const isSuper = !!superData;
      const { data: profile } = await supabase
        .from("admin_profiles")
        .select("name")
        .eq("user_id", user!.id)
        .maybeSingle();
      return {
        role,
        isSuperAdmin: isSuper,
        isAdmin: role === "admin" || isSuper,
        isManager: role === "manager" || role === "admin" || isSuper,
        isViewer: true,
        email: user?.email ?? null,
        displayName: (profile?.name as string) ?? null,
      };
    },
  });
}
