import { useState, useEffect } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";
import type { RulesConfig } from "@/types/domain";

interface Props {
  rules: RulesConfig | null;
  onSave: (rules: RulesConfig) => Promise<void>;
}

export function RulesPanel({ rules, onSave }: Props) {
  const [form, setForm] = useState<RulesConfig | null>(rules);
  const [saving, setSaving] = useState(false);

  useEffect(() => setForm(rules), [rules]);

  if (!form) return null;

  const set = <K extends keyof RulesConfig>(key: K, value: RulesConfig[K]) =>
    setForm({ ...form, [key]: value });

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form);
      toast({ title: "Configurações salvas", description: "O algoritmo já está usando as novas regras." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tente novamente.";
      toast({ title: "Erro ao salvar", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
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
        <Field
          label="Rev share do publisher (%)"
          hint="Quanto a rede (Google/AdSense/etc.) fica. Padrão: 6,5% (GAM). Afeta receita líquida e ROI."
          id="rev_share"
          value={form.revenue_share_pct ?? 6.5}
          onChange={(v) => set("revenue_share_pct", v)}
        />
      </div>

      <Separator />

      <div>
        <h3 className="font-semibold text-sm mb-3">Automação — Dias</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Field
            label="Dias de análise (automação)"
            hint="Janela usada pelo algoritmo de automação."
            id="auto_analysis_days"
            value={form.auto_analysis_days ?? 15}
            step="1"
            onChange={(v) => set("auto_analysis_days", v)}
          />
          <Field
            label="Intervalo entre escaladas (dias)"
            hint="Cooldown após aumentar orçamento."
            id="auto_scale_interval_days"
            value={form.auto_scale_interval_days ?? 3}
            step="1"
            onChange={(v) => set("auto_scale_interval_days", v)}
          />
          <Field
            label="Dias para stop-loss"
            hint="Dias seguidos com ROI ruim antes de pausar."
            id="auto_stoploss_days"
            value={form.auto_stoploss_days ?? 7}
            step="1"
            onChange={(v) => set("auto_stoploss_days", v)}
          />
          <Field
            label="Dias entre revisões de CPA"
            hint="Cooldown para ajustar target CPA."
            id="auto_cpa_review_days"
            value={form.auto_cpa_review_days ?? 3}
            step="1"
            onChange={(v) => set("auto_cpa_review_days", v)}
          />
          <Field
            label="Dias para entrar em standby"
            hint="Quanto tempo em baixo rendimento antes de standby."
            id="auto_standby_enter_days"
            value={form.auto_standby_enter_days ?? 7}
            step="1"
            onChange={(v) => set("auto_standby_enter_days", v)}
          />
          <Field
            label="Dias máximos em standby"
            hint="Limite antes de forçar pausa."
            id="auto_standby_max_days"
            value={form.auto_standby_max_days ?? 14}
            step="1"
            onChange={(v) => set("auto_standby_max_days", v)}
          />
        </div>
      </div>

      <Separator />

      <div>
        <h3 className="font-semibold text-sm mb-3">Automação — Thresholds</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Field
            label="ROI mínimo para escalar (%)"
            hint="Acima disso a campanha pode escalar."
            id="auto_scale_min_roi"
            value={form.auto_scale_min_roi ?? 30}
            onChange={(v) => set("auto_scale_min_roi", v)}
          />
          <Field
            label="% de aumento na escala"
            hint="Quanto o orçamento sobe ao escalar."
            id="auto_scale_budget_pct"
            value={form.auto_scale_budget_pct ?? 20}
            onChange={(v) => set("auto_scale_budget_pct", v)}
          />
          <Field
            label="ROI stop-loss (%)"
            hint="Abaixo disso, pausa (negativo)."
            id="auto_stoploss_min_roi"
            value={form.auto_stoploss_min_roi ?? -20}
            onChange={(v) => set("auto_stoploss_min_roi", v)}
          />
          <Field
            label="Gasto mínimo stop-loss (R$)"
            hint="Só pausa se gastou isso ou mais."
            id="auto_stoploss_min_cost"
            value={form.auto_stoploss_min_cost ?? 0}
            onChange={(v) => set("auto_stoploss_min_cost", v)}
          />
          <Field
            label="% aumento CPA"
            hint="Quanto sobe o target CPA para destravar."
            id="auto_cpa_up_pct"
            value={form.auto_cpa_up_pct ?? 10}
            onChange={(v) => set("auto_cpa_up_pct", v)}
          />
          <Field
            label="% redução CPA"
            hint="Quanto desce o target CPA para proteger."
            id="auto_cpa_down_pct"
            value={form.auto_cpa_down_pct ?? 10}
            onChange={(v) => set("auto_cpa_down_pct", v)}
          />
          <Field
            label="ROI baixo standby (%)"
            hint="Piso inferior do standby."
            id="auto_standby_roi_low"
            value={form.auto_standby_roi_low ?? 1}
            onChange={(v) => set("auto_standby_roi_low", v)}
          />
          <Field
            label="ROI alto standby (%)"
            hint="Teto do standby antes de virar learning."
            id="auto_standby_roi_high"
            value={form.auto_standby_roi_high ?? 10}
            onChange={(v) => set("auto_standby_roi_high", v)}
          />
          <Field
            label="ROI para sair do standby (%)"
            hint="Acima disso, a campanha sai do standby."
            id="auto_standby_exit_roi"
            value={form.auto_standby_exit_roi ?? 10}
            onChange={(v) => set("auto_standby_exit_roi", v)}
          />
        </div>
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
