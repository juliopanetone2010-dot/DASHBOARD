import { Globe, Check } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDashboardFilters } from "@/contexts/FilterContext";
import type { AccountSiteLink, Site } from "@/types/domain";

interface Props {
  sites: Site[];
  links: AccountSiteLink[];
  onChange?: (siteId: string) => void;
}

/**
 * Seletor GLOBAL de site — fica no header, persiste em localStorage,
 * e ao trocar auto-seleciona TODAS as contas Google Ads vinculadas ao site.
 */
export function GlobalSiteSelector({ sites, links, onChange }: Props) {
  const { filters, selectSite } = useDashboardFilters();

  const linksBySite = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const l of links) {
      const arr = m.get(l.site_id) ?? [];
      arr.push(l.google_account_id);
      m.set(l.site_id, arr);
    }
    return m;
  }, [links]);

  const handleChange = (siteId: string) => {
    const linked = siteId === "all" ? [] : (linksBySite.get(siteId) ?? []);
    selectSite(siteId, linked);
    onChange?.(siteId);
  };

  const currentLinkedCount = filters.siteId === "all"
    ? 0
    : (linksBySite.get(filters.siteId)?.length ?? 0);

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Globe className="h-3.5 w-3.5" /> Site
      </div>
      <Select value={filters.siteId} onValueChange={handleChange}>
        <SelectTrigger className="h-9 w-[240px]">
          <SelectValue placeholder="Selecione um site" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos os sites</SelectItem>
          {sites.map((s) => {
            const count = linksBySite.get(s.id)?.length ?? 0;
            return (
              <SelectItem key={s.id} value={s.id}>
                <span className="flex items-center gap-2">
                  <span>{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    ({count} {count === 1 ? "conta" : "contas"})
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {filters.siteId !== "all" && (
        <Badge variant="secondary" className="gap-1">
          <Check className="h-3 w-3" />
          {currentLinkedCount} {currentLinkedCount === 1 ? "conta Ads" : "contas Ads"}
        </Badge>
      )}
    </div>
  );
}
