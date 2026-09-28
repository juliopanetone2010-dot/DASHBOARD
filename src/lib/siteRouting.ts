// Roteamento campanha → site quando uma conta Ads está vinculada a mais de um site.
// Regra: a campanha vai para o site cujo domínio casa com o host da URL final
// (casamento exato; senão o domínio mais específico que for sufixo do host).
// Sem casamento, vai para o site principal da conta (is_primary).
// Mantenha em sincronia com supabase/functions/_shared/site_routing.ts.

export interface RoutingLink {
  google_account_id: string;
  site_id: string;
  is_primary?: boolean | null;
}

export interface RoutingSite {
  id: string;
  domain: string | null;
}

export function normalizeHost(raw: string | null | undefined): string {
  if (!raw) return "";
  let t = String(raw).trim().toLowerCase();
  t = t.replace(/^[a-z]+:\/\//, "");
  t = t.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  return t.replace(/^www\./, "");
}

/** Site principal de cada conta (is_primary; se nenhum marcado, o primeiro link). */
export function primarySiteByAccount(links: RoutingLink[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of links) {
    if (l.is_primary !== false && !out.has(l.google_account_id)) out.set(l.google_account_id, l.site_id);
  }
  for (const l of links) {
    if (!out.has(l.google_account_id)) out.set(l.google_account_id, l.site_id);
  }
  return out;
}

/** Contas vinculadas a mais de um site. */
export function multiSiteAccounts(links: RoutingLink[]): Set<string> {
  const count = new Map<string, number>();
  for (const l of links) count.set(l.google_account_id, (count.get(l.google_account_id) ?? 0) + 1);
  return new Set([...count.entries()].filter(([, n]) => n > 1).map(([id]) => id));
}

/** Escolhe, entre os sites da conta, o que casa com os hosts das URLs finais. */
export function pickSiteForHosts(hosts: string[], candidates: RoutingSite[]): string | null {
  let best: { id: string; len: number; exact: boolean } | null = null;
  for (const h of hosts) {
    if (!h) continue;
    for (const s of candidates) {
      const d = normalizeHost(s.domain);
      if (!d) continue;
      const exact = h === d;
      if (!exact && !h.endsWith(`.${d}`)) continue;
      if (!best || (exact && !best.exact) || (exact === best.exact && d.length > best.len)) {
        best = { id: s.id, len: d.length, exact };
      }
    }
  }
  return best?.id ?? null;
}

/**
 * A campanha pertence ao site? Campanha de conta com vários sites usa o mapa
 * (domínio da URL final); as demais seguem o vínculo conta ↔ site.
 */
export function campaignBelongsToSite(args: {
  campaignId: string;
  accountId: string | null | undefined;
  siteId: string;
  links: RoutingLink[];
  campaignSite: Map<string, string> | Record<string, string>;
}): boolean {
  const { campaignId, accountId, siteId, links, campaignSite } = args;
  const routed = campaignSite instanceof Map ? campaignSite.get(String(campaignId)) : campaignSite[String(campaignId)];
  if (routed) return routed === siteId;
  if (!accountId) return false;
  return links.some((l) => l.site_id === siteId && l.google_account_id === accountId);
}

/**
 * Mapa campaign_id (id do Google) → site_id, só para campanhas de contas com mais de um site.
 * Campanhas de contas com um site só não entram no mapa (o filtro por conta já resolve).
 */
export function buildCampaignSiteMap(args: {
  links: RoutingLink[];
  sites: RoutingSite[];
  campaigns: Array<{ campaign_id: string; google_account_id: string | null }>;
  finalUrls: Array<{ campaign_id: string; final_url: string | null }>;
}): Map<string, string> {
  const { links, sites, campaigns, finalUrls } = args;
  const multi = multiSiteAccounts(links);
  const out = new Map<string, string>();
  if (multi.size === 0) return out;
  const primary = primarySiteByAccount(links);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const hostsByCid = new Map<string, string[]>();
  for (const r of finalUrls) {
    const h = normalizeHost(r.final_url);
    if (!h) continue;
    const list = hostsByCid.get(String(r.campaign_id)) ?? [];
    if (!list.includes(h)) list.push(h);
    hostsByCid.set(String(r.campaign_id), list);
  }
  for (const c of campaigns) {
    const acc = c.google_account_id;
    if (!acc || !multi.has(acc)) continue;
    const candidates = links
      .filter((l) => l.google_account_id === acc)
      .map((l) => siteById.get(l.site_id))
      .filter((s): s is RoutingSite => !!s);
    const picked = pickSiteForHosts(hostsByCid.get(String(c.campaign_id)) ?? [], candidates);
    const siteId = picked ?? primary.get(acc);
    if (siteId) out.set(String(c.campaign_id), siteId);
  }
  return out;
}
