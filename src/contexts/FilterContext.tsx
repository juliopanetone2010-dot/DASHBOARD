import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { EMPTY_FILTERS, presetFromRange, DATE_PRESETS, type DashboardFilters, type DatePresetKey } from "@/components/dashboard/FilterBar";

interface FilterContextValue {
  filters: DashboardFilters;
  setFilters: (f: DashboardFilters) => void;
  /** Troca o site globalmente. Receba os accountIds vinculados para auto-selecionar. */
  selectSite: (siteId: string, linkedAccountIds: string[]) => void;
  /** Effective date range (yyyy-mm-dd). Defaults to last 7 days when nothing is set. */
  range: { from: string; to: string };
  presetKey: DatePresetKey | null;
  /** Bumped every time filters change — use as react-query / useEffect dep to force refetch. */
  version: number;
}

const FilterContext = createContext<FilterContextValue | null>(null);

const defaultRange = DATE_PRESETS.find((p) => p.key === "last_7_days")!.range();

const SITE_STORAGE_KEY = "dashboard:selected-site-id";

const loadPersistedSite = (): string => {
  try {
    return localStorage.getItem(SITE_STORAGE_KEY) || "all";
  } catch {
    return "all";
  }
};

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFiltersRaw] = useState<DashboardFilters>(() => ({
    ...EMPTY_FILTERS,
    siteId: loadPersistedSite(),
  }));
  const [version, setVersion] = useState(0);

  const setFilters = (f: DashboardFilters) => {
    setFiltersRaw(f);
    setVersion((v) => v + 1);
    try { localStorage.setItem(SITE_STORAGE_KEY, f.siteId); } catch { /* ignore */ }
    if (import.meta.env.DEV) console.info("[filters] changed →", f);
  };

  const selectSite = (siteId: string, linkedAccountIds: string[]) => {
    setFilters({
      ...filters,
      siteId,
      // Ao escolher um site, aplica TODAS as contas Ads vinculadas automaticamente.
      // "all" limpa o filtro de contas (mostra todas).
      googleAccountIds: siteId === "all" ? [] : linkedAccountIds,
    });
  };

  // Sincroniza entre abas/janelas
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SITE_STORAGE_KEY && e.newValue && e.newValue !== filters.siteId) {
        setFiltersRaw((prev) => ({ ...prev, siteId: e.newValue! }));
        setVersion((v) => v + 1);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [filters.siteId]);

  const value = useMemo<FilterContextValue>(() => {
    const from = filters.fromDate || defaultRange.from;
    const to = filters.toDate || defaultRange.to;
    return {
      filters,
      setFilters,
      selectSite,
      range: { from, to },
      presetKey: presetFromRange(filters.fromDate, filters.toDate),
      version,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, version]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useDashboardFilters() {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useDashboardFilters must be used inside <FilterProvider>");
  return ctx;
}
