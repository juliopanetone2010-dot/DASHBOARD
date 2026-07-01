// Utilitários para "Melhor Match" (últimos 10 dias) por campanha.
// Fonte: gam_campaign_source_revenue (utm_source='google').

export const BEST_MATCH_WINDOW_DAYS = 10;

export type DailyMatchRow = {
  date: string;               // YYYY-MM-DD
  matched: number;            // impressions
  requests: number;           // total_requests (0 quando indisponível)
  matchRate: number;          // percent 0..100
};

export type BestMatchInfo = {
  days: DailyMatchRow[];      // ordenado do mais recente ao mais antigo
  best: DailyMatchRow | null;
  today: DailyMatchRow | null; // dia mais recente com dados
  minRate: number | null;
  maxRate: number | null;
  stabilityDelta: number | null; // max-min em pontos percentuais
};

export function matchRateColor(pct: number | null | undefined): string {
  if (pct == null) return "text-muted-foreground";
  if (pct >= 95) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 90) return "text-green-600 dark:text-green-400";
  if (pct >= 80) return "text-yellow-600 dark:text-yellow-400";
  if (pct >= 70) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

export function stabilityLabel(delta: number | null): { label: string; className: string } {
  if (delta == null) return { label: "—", className: "text-muted-foreground" };
  if (delta < 3) return { label: "Muito estável", className: "text-emerald-600 dark:text-emerald-400" };
  if (delta < 8) return { label: "Estável", className: "text-green-600 dark:text-green-400" };
  if (delta < 15) return { label: "Oscilando", className: "text-yellow-600 dark:text-yellow-400" };
  return { label: "Muito instável", className: "text-red-600 dark:text-red-400" };
}

export function formatBrDate(iso: string): string {
  // "2026-06-29" -> "29/06"
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

// Agrega linhas cruas (uma por dia por linha) do gam_campaign_source_revenue já filtradas por campaign_id/site.
export function buildBestMatch(rawRows: Array<{ date: string; impressions: number; total_requests: number; match_rate_pct: number | null }>): BestMatchInfo {
  // Agrega por dia
  const byDate = new Map<string, { imp: number; req: number; weighted: number; ratedImp: number }>();
  for (const r of rawRows) {
    const k = String(r.date);
    const cur = byDate.get(k) ?? { imp: 0, req: 0, weighted: 0, ratedImp: 0 };
    const imp = Number(r.impressions ?? 0);
    const req = Number(r.total_requests ?? 0);
    const pct = r.match_rate_pct == null ? null : Number(r.match_rate_pct);
    cur.imp += imp;
    cur.req += req;
    if (pct != null && pct > 0 && imp > 0) {
      cur.weighted += pct * imp;
      cur.ratedImp += imp;
    }
    byDate.set(k, cur);
  }

  const days: DailyMatchRow[] = [];
  for (const [date, v] of byDate) {
    let rate: number | null = null;
    if (v.ratedImp > 0) rate = v.weighted / v.ratedImp;
    else if (v.req > 0) rate = (v.imp / v.req) * 100;
    // Regras: ignorar dias inválidos (requests=0 & rate null, ou matched=0)
    if (v.imp <= 0) continue;
    if (rate == null) continue;
    if (v.req <= 0 && v.ratedImp <= 0) continue;
    days.push({
      date,
      matched: v.imp,
      requests: v.req > 0 ? v.req : Math.round(v.imp / (rate / 100)),
      matchRate: rate,
    });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1)); // desc

  let best: DailyMatchRow | null = null;
  let min = Infinity, max = -Infinity;
  for (const d of days) {
    if (!best || d.matchRate > best.matchRate) best = d;
    if (d.matchRate < min) min = d.matchRate;
    if (d.matchRate > max) max = d.matchRate;
  }

  return {
    days,
    best,
    today: days[0] ?? null,
    minRate: days.length ? min : null,
    maxRate: days.length ? max : null,
    stabilityDelta: days.length ? max - min : null,
  };
}
