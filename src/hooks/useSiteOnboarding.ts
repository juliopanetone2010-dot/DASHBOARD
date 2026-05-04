import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type SiteSyncStatus = "idle" | "processing" | "completed" | "failed";

export interface SiteSyncState {
  status: SiteSyncStatus;
  error: string | null;
  startedAt: string | null;
  lastFullSyncAt: string | null;
  hasAdsLink: boolean;
  hasGamLink: boolean;
}

/** Dispara auto-onboarding quando o site mudar e ainda não tiver sido sincronizado.
 *  Faz polling a cada 5s enquanto status === "processing". */
export function useSiteOnboarding(siteId: string) {
  const qc = useQueryClient();
  const [trigger, setTrigger] = useState(0);

  const query = useQuery({
    queryKey: ["site-sync-state", siteId, trigger],
    enabled: siteId !== "all" && !!siteId,
    queryFn: async (): Promise<SiteSyncState | null> => {
      const { data: site } = await supabase
        .from("sites")
        .select("id, sync_status, sync_error, sync_started_at, last_full_sync_at, gam_account_id, network_code")
        .eq("id", siteId)
        .maybeSingle();
      if (!site) return null;
      const { count: adsLinks } = await supabase
        .from("account_site_links")
        .select("id", { count: "exact", head: true })
        .eq("site_id", siteId);
      return {
        status: (site.sync_status as SiteSyncStatus) ?? "idle",
        error: site.sync_error ?? null,
        startedAt: site.sync_started_at ?? null,
        lastFullSyncAt: site.last_full_sync_at ?? null,
        hasAdsLink: (adsLinks ?? 0) > 0,
        // GAM é acessado via network_code + service account JSON (não usa gam_account_id por usuário).
        hasGamLink: !!site.network_code || !!site.gam_account_id,
      };
    },
    refetchInterval: (q) => (q.state.data?.status === "processing" ? 5_000 : false),
    staleTime: 5_000,
  });

  // Auto-disparar onboarding quando site nunca foi sincronizado
  useEffect(() => {
    if (siteId === "all" || !query.data) return;
    const s = query.data;
    if (s.status === "idle" && !s.lastFullSyncAt && s.hasAdsLink) {
      void runOnboarding(siteId, false).then(() => setTrigger((t) => t + 1));
    }
    // refresh queries dependentes quando termina
    if (s.status === "completed") {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["site-metrics-daily"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, query.data?.status, query.data?.lastFullSyncAt, query.data?.hasAdsLink]);

  const refresh = async (force = false) => {
    await runOnboarding(siteId, force);
    setTrigger((t) => t + 1);
  };

  return { state: query.data ?? null, isLoading: query.isLoading, refresh };
}

async function runOnboarding(siteId: string, force: boolean) {
  try {
    await supabase.functions.invoke("site-auto-onboard", { body: { site_id: siteId, force } });
  } catch (e) {
    console.error("[site-auto-onboard] invoke error", e);
  }
}
