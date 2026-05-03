import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { EMPTY_FILTERS, presetFromRange, DATE_PRESETS, type DashboardFilters, type DatePresetKey } from "@/components/dashboard/FilterBar";

interface FilterContextValue {
  filters: DashboardFilters;
  setFilters: (f: DashboardFilters) => void;
  /** Effective date range (yyyy-mm-dd). Defaults to last 7 days when nothing is set. */
  range: { from: string; to: string };
  presetKey: DatePresetKey | null;
  /** Bumped every time filters change — use as react-query / useEffect dep to force refetch. */
  version: number;
}

const FilterContext = createContext<FilterContextValue | null>(null);

const defaultRange = DATE_PRESETS.find((p) => p.key === "last_7_days")!.range();

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFiltersRaw] = useState<DashboardFilters>(EMPTY_FILTERS);
  const [version, setVersion] = useState(0);

  const setFilters = (f: DashboardFilters) => {
    setFiltersRaw(f);
    setVersion((v) => v + 1);
    if (import.meta.env.DEV) {
      console.info("[filters] changed →", f);
    }
  };

  const value = useMemo<FilterContextValue>(() => {
    const from = filters.fromDate || defaultRange.from;
    const to = filters.toDate || defaultRange.to;
    return {
      filters,
      setFilters,
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
