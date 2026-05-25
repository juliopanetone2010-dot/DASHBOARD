export interface FinalUrlRow {
  campaign_id?: string | null;
  final_url?: string | null;
  mobile_url?: string | null;
  tracking_template?: string | null;
  final_url_suffix?: string | null;
  source?: string | null;
  updated_at?: string | null;
}

export interface FinalUrlMapEntry {
  url: string | null;
  source: string;
  trackingTemplate: string | null;
  finalUrlSuffix: string | null;
  mobileUrl: string | null;
}

const scoreRow = (row: FinalUrlRow) => {
  let score = 0;
  if (row.final_url) score += 100;
  if (row.source === "ad.final_urls") score += 20;
  if (row.final_url_suffix) score += 5;
  if (row.tracking_template) score += 3;
  if (row.mobile_url) score += 1;
  return score;
};

const isNewer = (candidate?: string | null, current?: string | null) => {
  const candidateTime = candidate ? Date.parse(candidate) : 0;
  const currentTime = current ? Date.parse(current) : 0;
  return candidateTime > currentTime;
};

export function buildFinalUrlMap(rows: FinalUrlRow[] | null | undefined) {
  const bestRows = new Map<string, FinalUrlRow>();

  for (const row of rows ?? []) {
    const campaignId = String(row.campaign_id ?? "");
    if (!campaignId) continue;

    const current = bestRows.get(campaignId);
    if (!current) {
      bestRows.set(campaignId, row);
      continue;
    }

    const candidateScore = scoreRow(row);
    const currentScore = scoreRow(current);
    if (candidateScore > currentScore || (candidateScore === currentScore && isNewer(row.updated_at, current.updated_at))) {
      bestRows.set(campaignId, row);
    }
  }

  const map = new Map<string, FinalUrlMapEntry>();
  for (const [campaignId, row] of bestRows.entries()) {
    const url = row.final_url ?? null;
    map.set(campaignId, {
      url,
      source: url ? String(row.source ?? "ad.final_urls") : "unknown",
      trackingTemplate: row.tracking_template ?? null,
      finalUrlSuffix: row.final_url_suffix ?? null,
      mobileUrl: row.mobile_url ?? null,
    });
  }

  return map;
}