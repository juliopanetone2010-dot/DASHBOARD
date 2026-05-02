import { useState, useEffect } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { RulesConfig } from "@/types/domain";

interface Props {
  rules: RulesConfig | null;
  onSaved: () => void;
}

export function RulesPanel({ rules, onSaved }: Props) {
  const { user } = useAuth();
  const [form, setForm] = useState<RulesConfig | null>(rules);
  const [saving, setSaving] = useState(false);

  useEffect(() => setForm(rules), [rules]);

  if (!form || !user) return null;

  const set = <K extends keyof RulesConfig>(key: K, value: RulesConfig[K]) =>
    setForm({ ...form, [key]: value });

  const handleSave = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("rules_config")
      .upsert({ ...form, user_id: user.id }, { onConflict: "user_id" });
    setSaving(false);
    if (error) {
      toast({ title: "Erro ao salvar", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Configurações salvas", description: "O algoritmo já está usando as novas regras." });
    onSaved();
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-elegant space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Regras do algoritmo</h2>
        <p className="text-sm text-muted-foreground">
          Defina os limites que disparam alertas e ações automáticas.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field
          label="ROI mínimo aceitável (%)"
          hint="Abaixo disso, vira aviso."
          id="min_roi"
          value={form.min_roi_pct}
          onChange={(v) => set("min_roi_pct", v)}
        />
        <Field
          label="Limite de prejuízo: ROI máx. negativo (%)"
          hint="Atinge esse patamar → pausa (se ativada)."
          id="max_loss"
          value={form.max_loss_roi_pct}
          onChange={(v) => set("max_loss_roi_pct", v)}
        />
        <Field
          label="ROI para aumento de orçamento (%)"
          hint="Acima disso, sugere boost."
          id="boost"
          value={form.boost_roi_pct}
          onChange={(v) => set("boost_roi_pct", v)}
        />
        <Field
          label="Dias para análise"
          hint="Janela usada nas regras."
          id="days"
          value={form.analysis_days}
          step="1"
          onChange={(v) => set("analysis_days", v)}
        />
        <Field
          label="Gasto mínimo para avaliar (R$)"
          hint="Abaixo disso, ignora a campanha."
          id="min_spend"
          value={form.min_spend_threshold}
          onChange={(v) => set("min_spend_threshold", v)}
        />
        <Field
          label="% de aumento de orçamento sugerido"
          hint="Aplicado quando há boost."
          id="boost_pct"
          value={form.budget_increase_pct}
          onChange={(v) => set("budget_increase_pct", v)}
        />
      </div>

      <Separator />

      <div className="space-y-3">
        <h3 className="font-semibold text-sm">Modo de execução</h3>
        <ToggleRow
          label="Pausa automática"
          hint="Quando ROI fica abaixo do limite de prejuízo, pausa sozinho."
          checked={form.auto_pause_enabled}
          onCheckedChange={(v) => set("auto_pause_enabled", v)}
        />
        <ToggleRow
          label="Aumento automático de orçamento"
          hint="Recomendado deixar desligado — você aprova manualmente."
          checked={form.auto_boost_enabled}
          onCheckedChange={(v) => set("auto_boost_enabled", v)}
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Salvar configurações
        </Button>
      </div>
    </div>
  );
}

function Field({
  label, hint, id, value, onChange, step,
}: {
  label: string; hint?: string; id: string; value: number; step?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        step={step ?? "0.01"}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  label, hint, checked, onCheckedChange,
}: {
  label: string; hint: string; checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div>
        <p className="font-medium text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
