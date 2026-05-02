import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtCurrency, fmtPercent } from "@/lib/format";
import type { CampaignAggregate } from "@/types/domain";
import type { PlacementAggregate } from "@/engine/rules";

interface CampaignsRankProps {
  campaigns: CampaignAggregate[];
  variant: "best" | "worst";
}

export function CampaignsRanking({ campaigns, variant }: CampaignsRankProps) {
  const sorted = [...campaigns].sort((a, b) => (variant === "best" ? b.roi - a.roi : a.roi - b.roi));
  const top = sorted.slice(0, 5);
  const Icon = variant === "best" ? TrendingUp : TrendingDown;
  const accent = variant === "best" ? "text-success" : "text-danger";

  return (
    <div className="rounded-xl border border-border bg-card shadow-elegant">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Icon className={cn("h-4 w-4", accent)} />
        <h2 className="text-sm font-semibold">
          {variant === "best" ? "Top campanhas" : "Piores campanhas"}
        </h2>
      </div>
      {top.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">Sem dados ainda.</p>
      ) : (
        <ul className="divide-y divide-border">
          {top.map((c, i) => {
            const positive = c.roi >= 0;
            return (
              <li key={c.campaign_id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-mono text-muted-foreground w-5">#{i + 1}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {fmtCurrency(c.spend)} → {fmtCurrency(c.revenue)}
                    </p>
                  </div>
                </div>
                <span
                  className={cn(
                    "text-xs font-bold tabular-nums px-2 py-1 rounded-md shrink-0",
                    positive ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                  )}
                >
                  {fmtPercent(c.roi)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function PlacementsRanking({ placements }: { placements: PlacementAggregate[] }) {
  const top = [...placements].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  return (
    <div className="rounded-xl border border-border bg-card shadow-elegant">
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-sm font-semibold">Top placements (receita)</h2>
      </div>
      {top.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">
          Sem dados de Ad Manager ainda.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {top.map((p, i) => (
            <li key={p.placement_key} className="px-5 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xs font-mono text-muted-foreground w-5">#{i + 1}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{p.site ?? p.placement_key}</p>
                  <p className="text-xs text-muted-foreground">{p.ad_unit ?? "—"}</p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold tabular-nums">{fmtCurrency(p.revenue)}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  eCPM {p.ecpm.toFixed(2)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
