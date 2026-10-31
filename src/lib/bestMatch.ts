// Utilitários para "Melhor Match" (últimos 10 dias) por campanha.
// Fonte: gam_campaign_source_revenue (utm_source='google').

export const BEST_MATCH_WINDOW_DAYS = 10;

export type DailyMatchRow = {
  date: string;               // YYYY-MM-DD
  matched: number;            // matched requests AdX (requests × taxa)
  requests: number;           // AD_EXCHANGE_TOTAL_REQUESTS (0 quando indisponível)
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

// Match rate = AD_EXCHANGE_MATCH_RATE do GAM da própria utm_campaign (matched requests ÷
// total requests AdX), gravado pelo sync com match_rate_source='campaign_real'.
// Qualquer outra origem (impressões/cliques, URL, site, proxy) NÃO é match rate → null ("—").
export function realMatchRatePct(row: { match_rate_pct: number | null | undefined; match_rate_source?: string | null }): number | null {
  if (row.match_rate_pct == null) return null;
  if (row.match_rate_source !== "campaign_real") return null;
  const v = Number(row.match_rate_pct);
  return Number.isFinite(v) && v > 0 ? Math.min(100, v) : null;
}

// Média do match rate ponderada por requests (Σ requests×taxa / Σ requests). Linhas sem
// requests entram com peso 1 só se nenhuma linha tiver requests.
export function aggregateMatchRate(rows: Array<{ total_requests: number; match_rate_pct: number | null; match_rate_source?: string | null }>): { rate: number | null; requests: number; matched: number } {
  let req = 0, matched = 0, n = 0, sumRate = 0;
  for (const r of rows) {
    const rate = realMatchRatePct(r);
    if (rate == null) continue;
    const q = Number(r.total_requests || 0);
    n++; sumRate += rate;
    if (q > 0) { req += q; matched += q * rate / 100; }
  }
  if (n === 0) return { rate: null, requests: 0, matched: 0 };
  if (req > 0) return { rate: (matched / req) * 100, requests: req, matched: Math.round(matched) };
  return { rate: sumRate / n, requests: 0, matched: 0 };
}

// Agrega linhas cruas (uma por dia por linha) do gam_campaign_source_revenue já filtradas por campaign_id/site.
export function buildBestMatch(rawRows: Array<{ date: string; impressions: number; total_requests: number; match_rate_pct: number | null; match_rate_source?: string | null }>): BestMatchInfo {
  const byDate = new Map<string, typeof rawRows>();
  for (const r of rawRows) {
    const k = String(r.date);
    const arr = byDate.get(k) ?? [];
    arr.push(r);
    byDate.set(k, arr);
  }

  const days: DailyMatchRow[] = [];
  for (const [date, arr] of byDate) {
    const agg = aggregateMatchRate(arr);
    if (agg.rate == null) continue; // sem taxa real da utm nesse dia → fora
    days.push({ date, matched: agg.matched, requests: agg.requests, matchRate: agg.rate });
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
