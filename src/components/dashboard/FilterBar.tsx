import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Campaign, GoogleAccount, Site } from "@/types/domain";

export interface DashboardFilters {
  googleAccountId: string; // "all" or id
  siteId: string;          // "all" or id
  campaignId: string;      // "all" or campaign_id (text)
  fromDate: string;        // "" or yyyy-mm-dd
  toDate: string;          // "" or yyyy-mm-dd
}

export const EMPTY_FILTERS: DashboardFilters = {
  googleAccountId: "all",
  siteId: "all",
  campaignId: "all",
  fromDate: "",
  toDate: "",
};

interface Props {
  filters: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
  googleAccounts: GoogleAccount[];
  sites: Site[];
  campaigns: Campaign[];
}

export function FilterBar({ filters, onChange, googleAccounts, sites, campaigns }: Props) {
  const set = <K extends keyof DashboardFilters>(k: K, v: DashboardFilters[K]) =>
    onChange({ ...filters, [k]: v });

  const isDirty =
    filters.googleAccountId !== "all" ||
    filters.siteId !== "all" ||
    filters.campaignId !== "all" ||
    filters.fromDate !== "" ||
    filters.toDate !== "";

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-elegant">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground pb-1.5 pr-1">
          <Filter className="h-3.5 w-3.5" /> Filtros
        </div>

        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Conta Ads</label>
          <Select value={filters.googleAccountId} onValueChange={(v) => set("googleAccountId", v)}>
            <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as contas</SelectItem>
              {googleAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.account_name ?? a.customer_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Site</label>
          <Select value={filters.siteId} onValueChange={(v) => set("siteId", v)}>
            <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os sites</SelectItem>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Campanha</label>
          <Select value={filters.campaignId} onValueChange={(v) => set("campaignId", v)}>
            <SelectTrigger className="h-9 w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as campanhas</SelectItem>
              {campaigns.map((c) => (
                <SelectItem key={c.campaign_id} value={c.campaign_id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">De</label>
          <Input
            type="date" className="h-9 w-[150px]"
            value={filters.fromDate}
            onChange={(e) => set("fromDate", e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Até</label>
          <Input
            type="date" className="h-9 w-[150px]"
            value={filters.toDate}
            onChange={(e) => set("toDate", e.target.value)}
          />
        </div>

        {isDirty && (
          <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)} className="h-9 gap-1">
            <X className="h-3.5 w-3.5" /> Limpar
          </Button>
        )}
      </div>
    </div>
  );
}
