import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  variant?: "default" | "success" | "danger" | "primary";
  hint?: string;
}

const variantStyles: Record<NonNullable<MetricCardProps["variant"]>, string> = {
  default: "bg-card",
  primary: "bg-gradient-primary text-primary-foreground border-transparent shadow-glow",
  success: "bg-gradient-success text-success-foreground border-transparent",
  danger: "bg-gradient-danger text-danger-foreground border-transparent",
};

export function MetricCard({ label, value, icon: Icon, variant = "default", hint }: MetricCardProps) {
  const isColored = variant !== "default";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border p-5 shadow-elegant transition-all hover:shadow-lifted animate-fade-in",
        variantStyles[variant],
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 min-w-0">
          <p className={cn("text-xs font-medium uppercase tracking-wider", isColored ? "opacity-90" : "text-muted-foreground")}>
            {label}
          </p>
          <p className="text-2xl md:text-3xl font-bold tracking-tight truncate">{value}</p>
          {hint && (
            <p className={cn("text-xs", isColored ? "opacity-80" : "text-muted-foreground")}>{hint}</p>
          )}
        </div>
        <div
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg",
            isColored ? "bg-white/20" : "bg-accent text-accent-foreground",
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}
