// Repartição da receita diária de uma rede GAM entre os sites dela, por host.
// Usado pelo gam-sync-revenue quando dois sites dividem o mesmo network_code.
import { pickSiteForHosts } from "./site_routing.ts";

export type SiteMetricRow = { date: string | null; impressions: number; measurable: number; viewable: number; revenue: number };

// Reparte o total do dia entre os sites da rede. Sites extras (índice > 0) ficam com a
// receita/impressões dos hosts deles (nunca mais que o total); o principal (índice 0)
// fica com o resto. measurable/viewable seguem a proporção de impressões.
export function splitSiteMetricRowsByHost(
  rows: SiteMetricRow[],
  sites: Array<{ id: string; domain: string | null }>,
  hostTotals: Map<string, Map<string, { impr: number; rev: number }>>,
): Map<string, SiteMetricRow[]> {
  const primaryId = sites[0]?.id;
  const bySite = new Map<string, SiteMetricRow[]>(sites.map((s) => [s.id, []]));
  for (const row of rows) {
    const hosts = (row.date ? hostTotals.get(row.date) : undefined) ?? new Map();
    const share = new Map<string, { impr: number; rev: number }>();
    for (const [host, v] of hosts) {
      const sid = pickSiteForHosts([host], sites);
      if (!sid || sid === primaryId) continue;
      const cur = share.get(sid) ?? { impr: 0, rev: 0 };
      cur.impr += v.impr; cur.rev += v.rev;
      share.set(sid, cur);
    }
    let restImpr = row.impressions, restRev = row.revenue, restMeas = row.measurable, restView = row.viewable;
    for (const s of sites.slice(1)) {
      const v = share.get(s.id) ?? { impr: 0, rev: 0 };
      const impr = Math.min(v.impr, restImpr);
      const rev = Math.min(v.rev, restRev);
      const f = row.impressions > 0 ? impr / row.impressions : 0;
      const meas = Math.min(restMeas, Math.round(row.measurable * f));
      const view = Math.min(restView, Math.round(row.viewable * f));
      bySite.get(s.id)!.push({ date: row.date, impressions: impr, measurable: meas, viewable: view, revenue: rev });
      restImpr -= impr; restRev -= rev; restMeas -= meas; restView -= view;
    }
    bySite.get(primaryId)!.push({
      date: row.date, impressions: restImpr, revenue: restRev, measurable: restMeas, viewable: restView,
    });
  }
  return bySite;
}
