import { useState } from "react";
import { Link2, Plus, Trash2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import type { AccountSiteLink, GoogleAccount, Site } from "@/types/domain";

interface Props {
  links: AccountSiteLink[];
  accounts: GoogleAccount[];
  sites: Site[];
  onAdd: (googleAccountId: string, siteId: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

export function LinksPanel({ links, accounts, sites, onAdd, onRemove }: Props) {
  const [accountId, setAccountId] = useState("");
  const [siteId, setSiteId] = useState("");

  const handleAdd = async () => {
    if (!accountId || !siteId) {
      toast({ title: "Selecione conta e site", variant: "destructive" });
      return;
    }
    await onAdd(accountId, siteId);
    setAccountId(""); setSiteId("");
    toast({ title: "Vínculo criado" });
  };

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const siteById = new Map(sites.map((s) => [s.id, s]));

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-elegant">
      <div className="mb-4">
        <h3 className="font-semibold flex items-center gap-2"><Link2 className="h-4 w-4" /> Vínculos Ads ↔ Site</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Mapeamento usado para casar receita do site com a campanha Ads correta.
          O match real acontece via UTM: <code>utm_campaign=campaignid</code>, <code>utm_placement=campaignid_placement</code>.
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-border p-3 mb-4 grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto] gap-2 items-end">
        <div className="space-y-1">
          <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Conta Ads</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger><SelectValue placeholder="Escolha uma conta" /></SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.account_name ?? a.customer_id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground self-center hidden md:block" />
        <div className="space-y-1">
          <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger><SelectValue placeholder="Escolha um site" /></SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={handleAdd} className="gap-1.5"><Plus className="h-3.5 w-3.5" /> Vincular</Button>
      </div>

      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">Nenhum vínculo criado.</p>
      ) : (
        <ul className="space-y-2">
          {links.map((l) => {
            const acc = accountById.get(l.google_account_id);
            const site = siteById.get(l.site_id);
            return (
              <li key={l.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-3 min-w-0 text-sm">
                  <span className="truncate font-medium">{acc?.account_name ?? acc?.customer_id ?? "—"}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="truncate text-muted-foreground">{site?.name ?? "—"}</span>
                </div>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-danger"
                  onClick={() => onRemove(l.id)} title="Remover">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
