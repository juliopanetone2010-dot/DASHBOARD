import { Flame, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { Alert } from "@/types/domain";

interface Props {
  alerts: Alert[];
  onAcknowledge: (id: string) => void;
}

const severityStyles: Record<Alert["severity"], string> = {
  critical: "border-l-danger bg-danger-soft/50",
  warning: "border-l-warning bg-warning/5",
  info: "border-l-primary bg-accent",
};

export function AlertsPanel({ alerts, onAcknowledge }: Props) {
  const open = alerts.filter((a) => !a.acknowledged);
  return (
    <div className="rounded-xl border border-border bg-card shadow-elegant overflow-hidden flex flex-col">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-danger" />
          <h2 className="text-sm font-semibold">Alertas</h2>
        </div>
        <span className="text-xs text-muted-foreground">{open.length} aberto(s)</span>
      </div>
      <ScrollArea className="h-[360px]">
        {open.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[300px] text-center px-6 text-muted-foreground">
            <Check className="h-8 w-8 mb-2 text-success" />
            <p className="text-sm">Nenhum alerta ativo. Tudo sob controle.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {open.map((a) => (
              <li
                key={a.id}
                className={cn("p-4 border-l-4 flex items-start gap-3", severityStyles[a.severity])}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{a.title}</p>
                  {a.message && (
                    <p className="text-xs text-muted-foreground mt-0.5">{a.message}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-1.5 uppercase tracking-wider">
                    {formatDistanceToNow(new Date(a.created_at), { addSuffix: true, locale: ptBR })}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  onClick={() => onAcknowledge(a.id)}
                  title="Marcar como lido"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
