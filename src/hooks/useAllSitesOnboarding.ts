import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface SiteRow {
  id: string;
  name: string;
  sync_status: string;
  last_full_sync_at: string | null;
  sync_started_at: string | null;
  ads_links: number;
}

/** Verifica todos os sites do usuário e expõe `syncAll(force)` para o botão global.
 *  Não dispara sync automático para evitar 429/504 ao trocar de site/aba. */
export function useAllSitesOnboarding(enabled: boolean) {
  const qc = useQueryClient();
  const triggeredRef = useRef<Set<string>>(new Set());

  const { data: sites, refetch } = useQuery({
    queryKey: ["all-sites-sync-state"],
    enabled,
    queryFn: async (): Promise<SiteRow[]> => {
      const { data: rows } = await supabase
        .from("sites")
        .select("id, name, sync_status, last_full_sync_at, sync_started_at");
      const ids = (rows ?? []).map((r) => r.id);
      if (ids.length === 0) return [];
      const { data: links } = await supabase
        .from("account_site_links")
        .select("site_id")
        .in("site_id", ids);
      const counts = new Map<string, number>();
      for (const l of links ?? []) counts.set(l.site_id, (counts.get(l.site_id) ?? 0) + 1);
      return (rows ?? []).map((r: any) => ({
        id: r.id,
        name: r.name,
        sync_status: r.sync_status ?? "idle",
        last_full_sync_at: r.last_full_sync_at,
        sync_started_at: r.sync_started_at,
        ads_links: counts.get(r.id) ?? 0,
      }));
    },
    refetchInterval: (q) =>
      (q.state.data ?? []).some((s) => s.sync_status === "processing") ? 8_000 : false,
    staleTime: 10_000,
  });

  // Apenas invalida dashboards quando algum processo manual termina.
  useEffect(() => {
    if (!enabled || !sites) return;
    if (sites.some((s) => s.sync_status === "completed")) {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["gam-freshness"] });
    }
  }, [enabled, sites, qc]);

  const syncAll = async (force = true) => {
    const eligibleSites = (sites ?? []).filter((s) => s.ads_links > 0);
    if (!eligibleSites.length) return;
    toast({
      title: "Sincronizando todos os sites",
      description: `${eligibleSites.length} site(s) em fila. Pode levar alguns minutos.`,
    });
    for (const s of eligibleSites) {
      await supabase.functions.invoke("site-auto-onboard", { body: { site_id: s.id, force } });
      await delay(12_000); // dá tempo do GAM resetar quota antes do próximo site
    }
    await refetch();
  };

  const processingCount = (sites ?? []).filter((s) => s.sync_status === "processing").length;
  const totalCount = sites?.length ?? 0;
  return { sites: sites ?? [], processingCount, totalCount, syncAll, refetch };
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
