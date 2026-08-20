import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCurrency, fmtUSD, fmtPercent, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  CampaignAggregate, GoogleAccount, Site,
  DailyMetric, Placement, AccountSiteLink,
} from "@/types/domain";
import type { PlacementAggregate } from "@/engine/rules";

interface Props {
  aggregates: CampaignAggregate[];
  placements: PlacementAggregate[];
  metrics: DailyMetric[];
  rawPlacements: Placement[];
  googleAccounts: GoogleAccount[];
  sites: Site[];
  links: AccountSiteLink[];
}

interface SegmentRow {
  key: string;
  label: string;
  spend: number;
  revenue: number;
  profit: number;
  roi: number;
  impressions?: number;
  ecpm?: number;
}

const calcRoi = (rev: number, sp: number) => (sp > 0 ? ((rev - sp) / sp) * 100 : 0);

function SegmentTable({ rows, withImpressions }: { rows: SegmentRow[]; withImpressions?: boolean }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-10">Sem dados para este segmento.</p>;
  }
  return (
    <div className="rounded-xl border border-border bg-card shadow-elegant overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="text-[10px] sm:text-xs">Segmento</TableHead>
              <TableHead className="text-right text-[10px] sm:text-xs">Gasto</TableHead>
              <TableHead className="text-right text-[10px] sm:text-xs">Receita</TableHead>
              <TableHead className="text-right text-[10px] sm:text-xs">Lucro</TableHead>
              <TableHead className="text-right text-[10px] sm:text-xs">ROI</TableHead>
              {withImpressions && <TableHead className="text-right">Impressões</TableHead>}
              {withImpressions && <TableHead className="text-right">eCPM</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const positive = r.profit >= 0;
              return (
                <TableRow key={r.key}>
                  <TableCell className="font-medium text-[10px] sm:text-sm">{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums text-[10px] sm:text-sm">{fmtCurrency(r.spend)}</TableCell>
                  <TableCell className="text-right tabular-nums text-[10px] sm:text-sm">{fmtUSD(r.revenue)}</TableCell>
                  <TableCell className={cn("text-right font-semibold tabular-nums text-[10px] sm:text-sm", positive ? "text-success" : "text-danger")}>
                    {fmtCurrency(r.profit)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={cn(
                      "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                      positive ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                    )}>
                      {fmtPercent(r.roi)}
                    </span>
                  </TableCell>
                  {withImpressions && (
                    <TableCell className="text-right tabular-nums text-muted-foreground text-[10px] sm:text-xs">
                      {fmtNumber(r.impressions ?? 0)}
                    </TableCell>
                  )}
                  {withImpressions && (
                    <TableCell className="text-right tabular-nums text-muted-foreground text-[10px] sm:text-xs">
                      {(r.ecpm ?? 0).toFixed(2)}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function SegmentTabs({
  aggregates, placements, googleAccounts, sites, links,
}: Props) {
  // Por conta Ads — soma os aggregates já líquidos (profit em BRL, revenue em USD)
  const byAccount: SegmentRow[] = (() => {
    const map = new Map<string, SegmentRow>();
    for (const a of aggregates) {
      const key = a.google_account_id ?? "unknown";
      const acc = googleAccounts.find((x) => x.id === key);
      const label = acc ? (acc.account_name ?? acc.customer_id) : "Sem conta vinculada";
      const cur = map.get(key) ?? { key, label, spend: 0, revenue: 0, profit: 0, roi: 0 };
      cur.spend += a.spend;
      cur.revenue += a.revenue;     // USD líquido
      cur.profit += a.profit;       // BRL líquido (= rev_brl - spend_brl, já com rev share)
      map.set(key, cur);
    }
    return [...map.values()].map((r) => ({
      ...r,
      roi: r.spend > 0 ? (r.profit / r.spend) * 100 : 0,
    }));
  })();

  // Por site — soma profit dos aggregates das contas vinculadas (mesma base, mesma moeda)
  const bySite: SegmentRow[] = (() => {
    const placementBySite = new Map<string, { rev: number; imp: number }>();
    for (const p of placements) {
      const s = sites.find((x) => x.name === p.site);
      const key = s?.id ?? p.site ?? "unknown";
      const cur = placementBySite.get(key) ?? { rev: 0, imp: 0 };
      cur.rev += p.revenue; cur.imp += p.impressions;
      placementBySite.set(key, cur);
    }
    const rows = new Map<string, SegmentRow>();
    for (const s of sites) {
      const linkedAccIds = links.filter((l) => l.site_id === s.id).map((l) => l.google_account_id);
      const accAggs = aggregates.filter((a) => linkedAccIds.includes(a.google_account_id ?? ""));
      const spend = accAggs.reduce((acc, a) => acc + a.spend, 0);
      const profit = accAggs.reduce((acc, a) => acc + a.profit, 0);
      const placeData = placementBySite.get(s.id) ?? { rev: 0, imp: 0 };
      const revenue = placeData.rev || accAggs.reduce((acc, a) => acc + a.revenue, 0);
      rows.set(s.id, {
        key: s.id,
        label: s.name,
        spend,
        revenue,
        profit,
        roi: spend > 0 ? (profit / spend) * 100 : 0,
        impressions: placeData.imp,
        ecpm: placeData.imp > 0 ? (placeData.rev / placeData.imp) * 1000 : 0,
      });
    }
    return [...rows.values()];
  })();

  // Por campanha
  const byCampaign: SegmentRow[] = aggregates.map((a) => ({
    key: a.campaign_id, label: a.name, spend: a.spend, revenue: a.revenue,
    profit: a.profit, roi: a.roi, impressions: a.impressions, ecpm: a.ecpm,
  }));

  // Por placement (sem custo Ads — só receita líquida do GAM)
  const byPlacement: SegmentRow[] = placements.map((p) => ({
    key: p.placement_key,
    label: `${p.site ?? "—"} • ${p.ad_unit ?? p.placement_key}`,
    spend: 0, revenue: p.revenue, profit: p.revenue, roi: 0,
    impressions: p.impressions, ecpm: p.ecpm,
  }));

  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Visão geral</TabsTrigger>
        <TabsTrigger value="account">Por conta Ads</TabsTrigger>
        <TabsTrigger value="site">Por site</TabsTrigger>
        <TabsTrigger value="campaign">Por campanha</TabsTrigger>
        <TabsTrigger value="placement">Por placement</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="mt-4">
        <SegmentTable rows={byAccount} />
      </TabsContent>
      <TabsContent value="account" className="mt-4">
        <SegmentTable rows={byAccount} />
      </TabsContent>
      <TabsContent value="site" className="mt-4">
        <SegmentTable rows={bySite} withImpressions />
      </TabsContent>
      <TabsContent value="campaign" className="mt-4">
        <SegmentTable rows={byCampaign} withImpressions />
      </TabsContent>
      <TabsContent value="placement" className="mt-4">
        <SegmentTable rows={byPlacement} withImpressions />
      </TabsContent>
    </Tabs>
  );
}
