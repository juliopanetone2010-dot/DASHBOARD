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
        "relative overflow-hidden rounded-xl border border-border p-3 sm:p-5 shadow-elegant transition-all hover:shadow-lifted animate-fade-in",
        variantStyles[variant],
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div
          className={cn(
            "sm:order-2 flex h-9 w-9 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-lg self-start",
            isColored ? "bg-white/20" : "bg-accent text-accent-foreground",
          )}
        >
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
        <div className="sm:order-1 space-y-1 sm:space-y-1.5 min-w-0 flex-1">
          <p
            className={cn(
              "text-[10px] sm:text-xs font-medium uppercase tracking-wider",
              isColored ? "opacity-90" : "text-muted-foreground",
            )}
          >
            {label}
          </p>
          <p className="text-lg sm:text-2xl md:text-3xl font-bold tracking-tight break-words leading-tight">{value}</p>
          {hint && (
            <p className={cn("text-[10px] sm:text-xs break-words", isColored ? "opacity-80" : "text-muted-foreground")}>{hint}</p>
          )}

        </div>
      </div>
    </div>
  );
}
