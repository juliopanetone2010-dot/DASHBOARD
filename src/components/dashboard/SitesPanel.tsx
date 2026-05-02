import { useState } from "react";
import { Plus, Trash2, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import type { Site } from "@/types/domain";

interface Props {
  sites: Site[];
  onAdd: (input: Partial<Site>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

export function SitesPanel({ sites, onAdd, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [networkCode, setNetworkCode] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !domain.trim() || !networkCode.trim()) {
      toast({ title: "Preencha todos os campos", variant: "destructive" });
      return;
    }
    await onAdd({
      name: name.trim(),
      domain: domain.trim(),
      network_code: networkCode.trim(),
    });
    setOpen(false);
    setName(""); setDomain(""); setNetworkCode("");
    toast({ title: "Site adicionado" });
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-elegant">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold flex items-center gap-2"><Globe className="h-4 w-4" /> Sites (GAM)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Propriedades monetizadas via Ad Manager</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5"><Plus className="h-3.5 w-3.5" /> Adicionar</Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleSubmit}>
              <DialogHeader><DialogTitle>Novo site</DialogTitle></DialogHeader>
              <div className="space-y-3 py-4">
                <div className="space-y-1.5">
                  <Label htmlFor="site-name">Nome</Label>
                  <Input id="site-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Notícias BR" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="site-domain">Domínio</Label>
                  <Input id="site-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="noticiasbr.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="site-nw">Network Code (GAM)</Label>
                  <Input id="site-nw" value={networkCode} onChange={(e) => setNetworkCode(e.target.value)} placeholder="21700000" />
                </div>
              </div>
              <DialogFooter><Button type="submit">Salvar</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {sites.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">Nenhum site cadastrado.</p>
      ) : (
        <ul className="space-y-2">
          {sites.map((s) => (
            <li key={s.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{s.name}</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {s.domain} • network {s.network_code}
                </p>
              </div>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-danger"
                onClick={() => onRemove(s.id)} title="Remover">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
