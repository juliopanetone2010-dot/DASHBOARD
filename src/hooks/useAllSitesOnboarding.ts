import { useEffect } from "react";
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
      qc.invalidateQueries({ queryKey: ["site-metrics-daily"] });
      qc.invalidateQueries({ queryKey: ["site-real-revenue"] });
      qc.invalidateQueries({ queryKey: ["campaign-gam-metrics"] });
      qc.invalidateQueries({ queryKey: ["retention"] });
      qc.invalidateQueries({ queryKey: ["extra-revenue"] });
    }
  }, [enabled, sites, qc]);

  const syncAll = async (force = true, range?: { from: string; to: string }) => {
    const eligibleSites = (sites ?? []).filter((s) => s.ads_links > 0);
    if (!eligibleSites.length) return;
    toast({
      title: "Sincronizando todos os sites",
      description: `${eligibleSites.length} site(s) em fila. Hoje e ontem serão conferidos primeiro.`,
    });

    const prevTo = range?.to ? previousDay(range.to) : undefined;
    const quickFrom = range?.from && prevTo
      ? (range.from <= prevTo ? prevTo : range.from)
      : range?.from;

    // Primeiro faz a conferência rápida de hoje/ontem em todos os sites e aguarda terminar.
    // Assim o card de receita e o calendário não ficam mostrando valor parcial/antigo
    // enquanto o sync completo de campanhas/placements continua em segundo plano.
    for (const s of eligibleSites) {
      await supabase.functions.invoke("site-auto-onboard", {
        body: { site_id: s.id, force: true, from: quickFrom, to: range?.to, quick_only: true },
      });
      await delay(2_000);
    }

    await Promise.all([
      qc.invalidateQueries({ queryKey: ["dashboard"] }),
      qc.invalidateQueries({ queryKey: ["gam-freshness"] }),
      qc.invalidateQueries({ queryKey: ["site-metrics-daily"] }),
      qc.invalidateQueries({ queryKey: ["site-real-revenue"] }),
      qc.invalidateQueries({ queryKey: ["dfs"] }),
      qc.invalidateQueries({ queryKey: ["calendar-site-metrics"] }),
    ]);

    // Depois dispara o sync completo, sem repetir a etapa rápida.
    for (const s of eligibleSites) {
      await supabase.functions.invoke("site-auto-onboard", {
        body: { site_id: s.id, force, from: range?.from, to: range?.to, skip_quick_revenue: true },
      });
      await delay(6_000); // reduz burst/429 no GAM antes do próximo site
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

function previousDay(iso: string) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
