// Util compartilhado de revshare para o frontend.
// Lê rules_config.revenue_share_pct (fallback 6.5). Futuro: aceitar siteId.
import { supabase } from "@/integrations/supabase/client";

export const DEFAULT_REV_SHARE_PCT = 6.5;

let cached: { pct: number; ts: number } | null = null;
const TTL_MS = 60_000;

export async function getRevSharePct(_siteId?: string | null): Promise<number> {
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.pct;
  try {
    const { data } = await supabase
      .from("rules_config")
      .select("revenue_share_pct")
      .maybeSingle();
    const v = Number((data as any)?.revenue_share_pct);
    const pct = Number.isFinite(v) && v >= 0 && v < 100 ? v : DEFAULT_REV_SHARE_PCT;
    cached = { pct, ts: Date.now() };
    return pct;
  } catch {
    return DEFAULT_REV_SHARE_PCT;
  }
}

export async function getNetFactor(siteId?: string | null): Promise<number> {
  return 1 - (await getRevSharePct(siteId)) / 100;
}

export function clearRevShareCache() { cached = null; }
