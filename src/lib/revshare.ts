// Util compartilhado de revshare para o frontend.
// Prioridade: sites.revenue_share_pct (override por site) → rules_config.revenue_share_pct
// (padrão global do usuário) → DEFAULT_REV_SHARE_PCT (6.5%, fallback duro).
import { supabase } from "@/integrations/supabase/client";

export const DEFAULT_REV_SHARE_PCT = 6.5;

let cachedGlobal: { pct: number; ts: number } | null = null;
const siteCache = new Map<string, { pct: number; ts: number }>();
const TTL_MS = 60_000;

async function getGlobalRevSharePct(): Promise<number> {
  if (cachedGlobal && Date.now() - cachedGlobal.ts < TTL_MS) return cachedGlobal.pct;
  try {
    const { data } = await supabase
      .from("rules_config")
      .select("revenue_share_pct")
      .maybeSingle();
    const v = Number((data as any)?.revenue_share_pct);
    const pct = Number.isFinite(v) && v >= 0 && v < 100 ? v : DEFAULT_REV_SHARE_PCT;
    cachedGlobal = { pct, ts: Date.now() };
    return pct;
  } catch {
    return DEFAULT_REV_SHARE_PCT;
  }
}

export async function getRevSharePct(siteId?: string | null): Promise<number> {
  if (siteId) {
    const hit = siteCache.get(siteId);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.pct;
    try {
      const { data } = await supabase
        .from("sites")
        .select("revenue_share_pct")
        .eq("id", siteId)
        .maybeSingle();
      const v = Number((data as any)?.revenue_share_pct);
      if (Number.isFinite(v) && v >= 0 && v < 100) {
        siteCache.set(siteId, { pct: v, ts: Date.now() });
        return v;
      }
    } catch { /* cai pro padrão global abaixo */ }
  }
  return getGlobalRevSharePct();
}

export async function getNetFactor(siteId?: string | null): Promise<number> {
  return 1 - (await getRevSharePct(siteId)) / 100;
}

export function clearRevShareCache(siteId?: string | null) {
  if (siteId) siteCache.delete(siteId);
  else { cachedGlobal = null; siteCache.clear(); }
}
