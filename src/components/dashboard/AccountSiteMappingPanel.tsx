import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertCircle, Save, RefreshCw, Briefcase } from "lucide-react";
import { AccountActions } from "./AccountActions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { AccountSiteLink, GoogleAccount, Site } from "@/types/domain";

interface Props {
  accounts: GoogleAccount[];
  sites: Site[];
  links: AccountSiteLink[];
  isGuest: boolean;
  onAddLink: (googleAccountId: string, siteId: string) => Promise<void>;
  onRemoveLink: (id: string) => Promise<void>;
  onArchiveAccount?: (id: string) => Promise<void>;
  onRemoveAccount?: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const NONE = "__none__";

export function AccountSiteMappingPanel({
  accounts, sites, links, isGuest, onAddLink, onRemoveLink, onArchiveAccount, onRemoveAccount, onRefresh,
}: Props) {
  // Mapeamento atual: account_id -> site_id (ou NONE)
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of accounts) {
      const link = links.find((l) => l.google_account_id === a.id);
      m[a.id] = link?.site_id ?? NONE;
    }
    return m;
  }, [accounts, links]);

  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [selectedApiSet, setSelectedApiSet] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { setDraft(initial); }, [initial]);

  const dirty = useMemo(() => {
    return Object.keys({ ...initial, ...draft }).some((k) => initial[k] !== draft[k]);
  }, [initial, draft]);

  // N:1 permitido — várias contas Ads podem apontar para o mesmo site.
  const siteUsageCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const siteId of Object.values(draft)) {
      if (siteId && siteId !== NONE) m.set(siteId, (m.get(siteId) ?? 0) + 1);
    }
    return m;
  }, [draft]);

  const handleSave = async () => {
    setSaving(true);
    try {
      for (const a of accounts) {
        const next = draft[a.id] ?? NONE;
        const current = links.find((l) => l.google_account_id === a.id);
        if (next === NONE && current) {
          await onRemoveLink(current.id);
        } else if (next !== NONE && (!current || current.site_id !== next)) {
          if (current) await onRemoveLink(current.id);
          await onAddLink(a.id, next);
        }
      }
      toast({ title: "Mapeamento salvo", description: "Vínculos conta Ads ↔ site atualizados." });
    } catch (e) {
      toast({ title: "Erro ao salvar", description: String(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleSyncMccWithApiSet = async (apiSet: number) => {
    if (isGuest) {
      toast({
        title: "Login necessário",
        description: "Para sincronizar contas reais do MCC, faça login.",
        variant: "destructive",
      });
      return;
    }
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-ads-list-accounts", {
        body: { api_set: apiSet, force_all: true },
      });
      if (error) throw error;
      const summary = (data as { summary?: Array<{ manager: string; synced: number; error?: string }> })?.summary ?? [];
      const total = summary.reduce((s, x) => s + x.synced, 0);
      toast({
        title: total > 0 ? "Contas sincronizadas" : "Nada novo",
        description: total > 0
          ? `${total} conta(s) importada(s) do MCC (API ${apiSet}).`
          : (summary.find((s) => s.error)?.error ?? "Nenhuma conta ativa encontrada nesta MCC."),
      });
      await onRefresh();
    } catch (e) {
      toast({ title: "Erro ao sincronizar", description: String(e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncMcc = async () => {
    if (isGuest) {
      toast({
        title: "Login necessário",
        description: "Para sincronizar contas reais do MCC, faça login.",
        variant: "destructive",
      });
      return;
    }
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-ads-list-accounts", {
        body: { force_all: true },
      });
      if (error) throw error;
      const summary = (data as { summary?: Array<{ manager: string; synced: number; error?: string }> })?.summary ?? [];
      const total = summary.reduce((s, x) => s + x.synced, 0);
      toast({
        title: total > 0 ? "Contas sincronizadas" : "Nada novo",
        description: total > 0
          ? `${total} conta(s) importada(s) do MCC.`
          : (summary.find((s) => s.error)?.error ?? "Nenhuma conta filha encontrada."),
      });
      await onRefresh();
    } catch (e) {
      toast({ title: "Erro ao sincronizar", description: String(e), variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  // Filtrar contas pelo API Set selecionado
  const childAccounts = useMemo(() => {
    if (!selectedApiSet) return accounts;
    return accounts.filter(a => a.api_set === selectedApiSet || a.is_mcc);
  }, [accounts, selectedApiSet]);

  const mccCount = accounts.filter((a) => a.is_mcc).length;

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-elegant">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <Briefcase className="h-4 w-4" /> Mapeamento Ads ↔ Site
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cada conta Ads é vinculada a <strong>um único site (GAM)</strong>. O cruzamento de receita
            usa este mapeamento + UTMs.
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {mccCount} MCC conectado(s) · {childAccounts.length} conta(s) operacional(is)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 bg-muted/50 rounded-md px-2 py-1 border border-border">
            <span className="text-[10px] font-medium uppercase text-muted-foreground">MCC:</span>
            <Select 
              value={selectedApiSet?.toString() || ""} 
              onValueChange={(v) => {
                const apiSet = v === "all" ? null : Number(v);
                setSelectedApiSet(apiSet);
                if (apiSet) handleSyncMccWithApiSet(apiSet);
              }}
            >
              <SelectTrigger className="h-7 w-32 text-xs border-none bg-transparent focus:ring-0">
                <SelectValue placeholder="Selecionar MCC" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Ver Todas</SelectItem>
                {[1, 2, 3, 4, 5].map(i => (
                  <SelectItem key={i} value={i.toString()}>MCC (API {i})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={handleSyncMcc} disabled={syncing} className="h-7 w-7 p-0">
              <RefreshCw className={syncing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            </Button>
          </div>
          <Button onClick={handleSave} disabled={!dirty || saving} className="gap-1.5 h-9">
            <Save className="h-3.5 w-3.5" /> Salvar Mapeamento
          </Button>
        </div>
      </div>

      {childAccounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {mccCount > 0
              ? "Nenhuma conta operacional ainda. Clique em \"Sincronizar contas do MCC\" para importar as sub-contas."
              : "Conecte um MCC primeiro para listar suas contas Ads automaticamente."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {childAccounts.map((acc) => {
            const selected = draft[acc.id] ?? NONE;
            const linked = selected !== NONE;
            const currentCount = selected !== NONE ? (siteUsageCount.get(selected) ?? 0) : 0;
            return (
              <article
                key={acc.id}
                className={`rounded-xl border bg-muted/20 p-4 transition-colors ${
                  linked ? "border-success/40" : "border-border"
                }`}
              >
                <header className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm font-semibold truncate">
                        {acc.account_name ?? acc.descriptive_name ?? acc.customer_id}
                      </h4>
                      {acc.currency && (
                        <Badge variant="secondary" className="text-[10px]">{acc.currency}</Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                      Customer ID: {formatCid(acc.customer_id)}
                    </p>
                  </div>
                  {linked ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success shrink-0">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Vinculado
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning shrink-0">
                      <AlertCircle className="h-3.5 w-3.5" /> Não vinculado
                    </span>
                  )}
                  {onArchiveAccount && onRemoveAccount && (
                    <AccountActions
                      accountId={acc.id}
                      accountName={acc.account_name ?? acc.customer_id}
                      onArchive={onArchiveAccount}
                      onRemove={onRemoveAccount}
                    />
                  )}
                </header>

                <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Site (GAM)
                </label>
                <Select
                  value={selected}
                  onValueChange={(v) => setDraft((p) => ({ ...p, [acc.id]: v }))}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Selecionar site" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>— Nenhum —</SelectItem>
                    {sites.map((s) => {
                      const count = siteUsageCount.get(s.id) ?? 0;
                      return (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} {count > 0 ? `(${count} conta${count > 1 ? "s" : ""})` : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {currentCount > 1 && (
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Compartilhado com outras {currentCount - 1} conta(s) — receita será atribuída via UTM.
                  </p>
                )}

                {sites.length === 0 && (
                  <p className="text-[11px] text-muted-foreground mt-2">
                    Cadastre um site abaixo para poder vincular.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatCid(cid: string) {
  const digits = cid.replace(/\D/g, "");
  if (digits.length !== 10) return cid;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}
