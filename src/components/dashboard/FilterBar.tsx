import { Check, ChevronDown, Filter, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Campaign, GoogleAccount, Site } from "@/types/domain";

// Usa data local (timezone do usuário), não UTC — evita "Hoje" vazio perto da meia-noite
const toISO = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

export type DatePresetKey = "today" | "yesterday" | "last_3_days" | "last_7_days" | "last_30_days";

export const DATE_PRESETS: Array<{ key: DatePresetKey; label: string; gaql: string; range: () => { from: string; to: string } }> = [
  { key: "today", label: "Hoje", gaql: "TODAY", range: () => ({ from: toISO(new Date()), to: toISO(new Date()) }) },
  { key: "yesterday", label: "Ontem", gaql: "YESTERDAY", range: () => ({ from: toISO(daysAgo(1)), to: toISO(daysAgo(1)) }) },
  { key: "last_3_days", label: "Últimos 3 dias", gaql: "LAST_7_DAYS", range: () => ({ from: toISO(daysAgo(2)), to: toISO(new Date()) }) },
  { key: "last_7_days", label: "Últimos 7 dias", gaql: "LAST_7_DAYS", range: () => ({ from: toISO(daysAgo(6)), to: toISO(new Date()) }) },
  { key: "last_30_days", label: "Últimos 30 dias", gaql: "LAST_30_DAYS", range: () => ({ from: toISO(daysAgo(29)), to: toISO(new Date()) }) },
];

export function presetFromRange(from: string, to: string): DatePresetKey | null {
  for (const p of DATE_PRESETS) {
    const r = p.range();
    if (r.from === from && r.to === to) return p.key;
  }
  return null;
}

export interface DashboardFilters {
  googleAccountIds: string[]; // empty = all accounts
  siteId: string;          // "all" or id
  campaignId: string;      // "all" or campaign_id (text)
  fromDate: string;        // "" or yyyy-mm-dd
  toDate: string;          // "" or yyyy-mm-dd
}

export const EMPTY_FILTERS: DashboardFilters = {
  googleAccountIds: [],
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
  onPresetApply?: (preset: DatePresetKey, gaql: string) => void;
}

export function FilterBar({ filters, onChange, googleAccounts, sites, campaigns, onPresetApply }: Props) {
  const set = <K extends keyof DashboardFilters>(k: K, v: DashboardFilters[K]) =>
    onChange({ ...filters, [k]: v });

  const selectedAccountIds = filters.googleAccountIds;
  const allAccountsSelected = selectedAccountIds.length === 0;
  const accountLabel = allAccountsSelected
    ? "Todas as contas"
    : selectedAccountIds.length === 1
      ? googleAccounts.find((a) => a.id === selectedAccountIds[0])?.account_name
        ?? googleAccounts.find((a) => a.id === selectedAccountIds[0])?.customer_id
        ?? "1 conta selecionada"
      : `${selectedAccountIds.length} contas selecionadas`;

  const toggleAccount = (id: string) => {
    const next = selectedAccountIds.includes(id)
      ? selectedAccountIds.filter((accountId) => accountId !== id)
      : [...selectedAccountIds, id];
    set("googleAccountIds", next);
  };

  const isDirty =
    filters.googleAccountIds.length > 0 ||
    filters.siteId !== "all" ||
    filters.campaignId !== "all" ||
    filters.fromDate !== "" ||
    filters.toDate !== "";

  const activePreset = presetFromRange(filters.fromDate, filters.toDate);

  const applyPreset = (key: DatePresetKey) => {
    const preset = DATE_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    const r = preset.range();
    onChange({ ...filters, fromDate: r.from, toDate: r.to });
    onPresetApply?.(key, preset.gaql);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-elegant space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground pr-1">
          <Zap className="h-3.5 w-3.5" /> Período
        </div>
        {DATE_PRESETS.map((p) => (
          <Button
            key={p.key}
            type="button"
            size="sm"
            variant={activePreset === p.key ? "default" : "outline"}
            onClick={() => applyPreset(p.key)}
            className="h-8"
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground pb-1.5 pr-1">
          <Filter className="h-3.5 w-3.5" /> Filtros
        </div>

        <div className="space-y-1">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Conta Ads</label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" className="h-9 w-[210px] justify-between gap-2 px-3 font-normal">
                <span className="truncate">{accountLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-[240px]" align="start">
              <DropdownMenuCheckboxItem checked={allAccountsSelected} onCheckedChange={() => set("googleAccountIds", [])}>
                Todas as contas
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {googleAccounts.map((a) => (
                <DropdownMenuCheckboxItem
                  key={a.id}
                  checked={allAccountsSelected || selectedAccountIds.includes(a.id)}
                  onCheckedChange={() => toggleAccount(a.id)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="truncate">{a.account_name ?? a.customer_id}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {!allAccountsSelected && <Badge variant="secondary">{selectedAccountIds.length} selecionada(s)</Badge>}
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
