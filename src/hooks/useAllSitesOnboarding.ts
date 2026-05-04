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

/** Verifica todos os sites do usuário e dispara `site-auto-onboard` em background
 *  para qualquer site que ainda não foi sincronizado (uma vez por sessão).
 *  Também expõe `syncAll(force)` para o botão global. */
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

  // Auto-disparo em background — uma vez por site por sessão
  useEffect(() => {
    if (!enabled || !sites) return;
    for (const s of sites) {
      if (triggeredRef.current.has(s.id)) continue;
      const startedAt = s.sync_started_at ? new Date(s.sync_started_at).getTime() : 0;
      const ageMin = (Date.now() - startedAt) / 60000;
      const stuck = s.sync_status === "processing" && ageMin > 10;
      const needs = s.ads_links > 0 && !s.last_full_sync_at && (s.sync_status === "idle" || stuck);
      if (!needs) continue;
      triggeredRef.current.add(s.id);
      void supabase.functions.invoke("site-auto-onboard", { body: { site_id: s.id, force: stuck } });
    }
    // invalidate dashboards quando algum termina
    if (sites.some((s) => s.sync_status === "completed")) {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }, [enabled, sites, qc]);

  const syncAll = async (force = true) => {
    if (!sites?.length) return;
    toast({
      title: "Sincronizando todos os sites",
      description: `${sites.length} site(s) em fila. Pode levar alguns minutos.`,
    });
    await Promise.all(
      sites.map((s) =>
        supabase.functions.invoke("site-auto-onboard", { body: { site_id: s.id, force } }),
      ),
    );
    await refetch();
  };

  const processingCount = (sites ?? []).filter((s) => s.sync_status === "processing").length;
  const totalCount = sites?.length ?? 0;
  return { sites: sites ?? [], processingCount, totalCount, syncAll, refetch };
}
