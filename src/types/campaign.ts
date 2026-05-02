export interface Campaign {
  campaignId: string;
  name: string;
  spend: number;
  revenue: number;
  date: string; // ISO yyyy-mm-dd
}

export interface CampaignWithMetrics extends Campaign {
  profit: number;
  roi: number;
}

export function withMetrics(c: Campaign): CampaignWithMetrics {
  const profit = c.revenue - c.spend;
  const roi = c.spend > 0 ? (profit / c.spend) * 100 : 0;
  return { ...c, profit, roi };
}
