import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Campaign } from "@/types/campaign";

interface Props {
  onSubmit: (c: Campaign) => Promise<void> | void;
  initial?: Campaign;
  trigger?: React.ReactNode;
}

export function CampaignFormDialog({ onSubmit, initial, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const [campaignId, setCampaignId] = useState("");
  const [name, setName] = useState("");
  const [spend, setSpend] = useState<string>("");
  const [revenue, setRevenue] = useState<string>("");
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    if (open && initial) {
      setCampaignId(initial.campaignId);
      setName(initial.name);
      setSpend(String(initial.spend));
      setRevenue(String(initial.revenue));
      setDate(initial.date);
    } else if (open && !initial) {
      setCampaignId("");
      setName("");
      setSpend("");
      setRevenue("");
      setDate(new Date().toISOString().slice(0, 10));
    }
  }, [open, initial]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit({
      campaignId: campaignId.trim(),
      name: name.trim(),
      spend: parseFloat(spend) || 0,
      revenue: parseFloat(revenue) || 0,
      date,
    });
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button className="gap-2">
            <Plus className="h-4 w-4" /> Nova campanha
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Editar campanha" : "Adicionar campanha"}</DialogTitle>
          <DialogDescription>
            Insira manualmente o gasto (Google Ads) e a receita (Ad Manager).
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cid">Campaign ID</Label>
              <Input
                id="cid"
                required
                disabled={!!initial}
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                placeholder="GA-1006"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">Data</Label>
              <Input id="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name">Nome da campanha</Label>
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Search - Notícias BR" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="spend">Gasto (R$)</Label>
              <Input id="spend" type="number" step="0.01" min="0" required value={spend} onChange={(e) => setSpend(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="revenue">Receita (R$)</Label>
              <Input id="revenue" type="number" step="0.01" min="0" required value={revenue} onChange={(e) => setRevenue(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit">{initial ? "Salvar" : "Adicionar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
