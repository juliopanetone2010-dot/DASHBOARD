// Camada de serviço preparada para futura integração com:
// - Google Ads API (gasto)
// - Google Ad Manager API (receita)
//
// Hoje retorna dados mockados / persistidos em localStorage.
// Para integrar no futuro, basta substituir as funções abaixo
// por chamadas reais (ex.: edge function do Lovable Cloud).

import type { Campaign } from "@/types/campaign";

const STORAGE_KEY = "roi-dashboard-campaigns";

const seed: Campaign[] = [
  { campaignId: "GA-1001", name: "Search - Notícias BR", spend: 1240.5, revenue: 2180.4, date: "2026-04-28" },
  { campaignId: "GA-1002", name: "Display - Esportes",     spend: 860.0,  revenue: 1320.75, date: "2026-04-29" },
  { campaignId: "GA-1003", name: "Discovery - Lifestyle",  spend: 540.25, revenue: 410.0,   date: "2026-04-30" },
  { campaignId: "GA-1004", name: "YouTube - Tech",         spend: 1980.0, revenue: 3450.6,  date: "2026-05-01" },
  { campaignId: "GA-1005", name: "Search - Finanças",      spend: 720.0,  revenue: 1995.2,  date: "2026-05-01" },
];

function load(): Campaign[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
      return seed;
    }
    return JSON.parse(raw) as Campaign[];
  } catch {
    return seed;
  }
}

function save(list: Campaign[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// Simula latência de rede para deixar a UX próxima do real
const delay = (ms = 350) => new Promise((r) => setTimeout(r, ms));

export async function fetchCampaigns(): Promise<Campaign[]> {
  await delay();
  return load();
}

export async function upsertCampaign(c: Campaign): Promise<Campaign> {
  await delay(150);
  const list = load();
  const idx = list.findIndex((x) => x.campaignId === c.campaignId);
  if (idx >= 0) list[idx] = c;
  else list.unshift(c);
  save(list);
  return c;
}

export async function deleteCampaign(campaignId: string): Promise<void> {
  await delay(120);
  const list = load().filter((c) => c.campaignId !== campaignId);
  save(list);
}

// Placeholders para integração futura:
// export async function syncFromGoogleAds() { /* TODO */ }
// export async function syncFromAdManager() { /* TODO */ }
