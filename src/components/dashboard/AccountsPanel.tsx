import { useState } from "react";
import { Plus, Trash2, ShieldCheck, ShieldAlert, Briefcase, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import type { GoogleAccount } from "@/types/domain";

interface Props {
  accounts: GoogleAccount[];
  onAdd: (input: Partial<GoogleAccount>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  isGuest: boolean;
}

export function AccountsPanel({ accounts, onAdd, onRemove, isGuest }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [loginCustomerId, setLoginCustomerId] = useState("");
  const [isMcc, setIsMcc] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId.trim()) {
      toast({ title: "Customer ID obrigatório", variant: "destructive" });
      return;
    }
    await onAdd({
      account_name: name.trim() || null,
      customer_id: customerId.trim(),
      login_customer_id: loginCustomerId.trim() || null,
      is_mcc: isMcc,
      status: isGuest ? "guest" : "pending",
    });
    setOpen(false);
    setName(""); setCustomerId(""); setLoginCustomerId(""); setIsMcc(false);
    toast({ title: "Conta Google Ads adicionada" });
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-elegant">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><Briefcase className="h-4 w-4" /> Contas Google Ads</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Suporte a múltiplas contas e MCC</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5"><Plus className="h-3.5 w-3.5" /> Adicionar</Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>Nova conta Google Ads</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-4">
                <div className="space-y-1.5">
                  <Label htmlFor="acc-name">Nome (opcional)</Label>
                  <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: MCC Principal" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="acc-cid">Customer ID</Label>
                  <Input id="acc-cid" value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="123-456-7890" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="acc-lcid">Login Customer ID (MCC pai)</Label>
                  <Input id="acc-lcid" value={loginCustomerId} onChange={(e) => setLoginCustomerId(e.target.value)} placeholder="opcional" />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div>
                    <Label className="text-sm">É um MCC?</Label>
                    <p className="text-xs text-muted-foreground">Conta gerenciadora (manager account)</p>
                  </div>
                  <Switch checked={isMcc} onCheckedChange={setIsMcc} />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit">Salvar</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">Nenhuma conta cadastrada.</p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-3 min-w-0">
                {a.status === "connected" ? (
                  <ShieldCheck className="h-4 w-4 text-success shrink-0" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-warning shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{a.account_name ?? a.customer_id}</span>
                    {a.is_mcc && <Badge variant="secondary" className="text-[10px]">MCC</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono">{a.customer_id}</p>
                </div>
              </div>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-danger"
                onClick={() => onRemove(a.id)} title="Remover">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
