import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Percent, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { Site } from "@/types/domain";

interface Props {
  sites: Site[];
  defaultPct: number;
  onSaved: () => Promise<void> | void;
}

// Revshare por site: a maioria fica no padrão (6.5%), mas alguns sites têm acordo
// diferente com a rede. Editável direto aqui — sem precisar entrar em Regras/Automação,
// que só tinha um valor global (e nem era usado no cálculo real, só aqui/na engine agora).
export function SiteRevShareEditor({ sites, defaultPct, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  if (sites.length === 0) return null;

  const valueFor = (site: Site) => {
    if (drafts[site.id] !== undefined) return drafts[site.id];
    const v = site.revenue_share_pct;
    return Number.isFinite(v as number) ? String(v) : String(defaultPct);
  };

  const save = async (site: Site) => {
    const raw = drafts[site.id];
    if (raw === undefined) return;
    const v = Number(raw.replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || v >= 100) {
      toast({ title: "Valor inválido", description: "Use um % entre 0 e 100.", variant: "destructive" });
      return;
    }
    setSavingId(site.id);
    try {
      // "as any": coluna nova (revenue_share_pct), ainda não presente nos tipos gerados do Supabase.
      const { error } = await (supabase as any).from("sites").update({ revenue_share_pct: v }).eq("id", site.id);
      if (error) throw error;
      setDrafts((d) => { const n = { ...d }; delete n[site.id]; return n; });
      await onSaved();
      toast({ title: "Revshare atualizado", description: `${site.name}: ${v}%` });
    } catch (e: any) {
      toast({ title: "Erro ao salvar", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Percent className="h-3.5 w-3.5" /> Revshare por site
          <span className="font-normal opacity-70">(padrão {defaultPct}% — usado no cálculo de lucro/ROI)</span>
        </span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="border-t border-border p-3 space-y-1.5 max-h-64 overflow-y-auto">
          {sites.map((s) => {
            const dirty = drafts[s.id] !== undefined && drafts[s.id] !== (Number.isFinite(s.revenue_share_pct as number) ? String(s.revenue_share_pct) : String(defaultPct));
            return (
              <div key={s.id} className="flex items-center gap-2">
                <span className="flex-1 text-sm truncate" title={s.name}>{s.name}</span>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    max="99.9"
                    value={valueFor(s)}
                    onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                    className="h-7 w-20 text-right text-xs"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    disabled={!dirty || savingId === s.id}
                    onClick={() => save(s)}
                  >
                    {savingId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
