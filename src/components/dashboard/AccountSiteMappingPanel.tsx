import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, AlertCircle, Save, RefreshCw, Briefcase } from "lucide-react";
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
  onRefresh: () => Promise<void>;
}

const NONE = "__none__";

export function AccountSiteMappingPanel({
  accounts, sites, links, isGuest, onAddLink, onRemoveLink, onRefresh,
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
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => { setDraft(initial); }, [initial]);

  const dirty = useMemo(() => {
    return Object.keys({ ...initial, ...draft }).some((k) => initial[k] !== draft[k]);
  }, [initial, draft]);

  // Sites já usados por OUTRA conta (regra 1:1) — para desabilitar nas outras dropdowns
  const siteUsageByOthers = (currentAccId: string) => {
    const used = new Set<string>();
    for (const [accId, siteId] of Object.entries(draft)) {
      if (accId !== currentAccId && siteId && siteId !== NONE) used.add(siteId);
    }
    return used;
  };

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
        body: {},
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

  // Separar MCCs (gerenciadoras) das contas operacionais
  const childAccounts = accounts.filter((a) => !a.is_mcc);
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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSyncMcc} disabled={syncing} className="gap-1.5">
            <RefreshCw className={syncing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            Sincronizar contas do MCC
          </Button>
          <Button onClick={handleSave} disabled={!dirty || saving} className="gap-1.5">
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
            const blockedSites = siteUsageByOthers(acc.id);
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
                      const blocked = blockedSites.has(s.id);
                      return (
                        <SelectItem key={s.id} value={s.id} disabled={blocked}>
                          {s.name} {blocked ? "(em uso)" : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>

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
