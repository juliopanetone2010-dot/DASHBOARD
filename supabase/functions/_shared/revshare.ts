// Util compartilhado de revshare. Lê rules_config.revenue_share_pct (fallback 6.5).
// Futuro: aceitar siteId para ler de site_config.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

export const DEFAULT_REV_SHARE_PCT = 6.5;

export async function getRevSharePct(
  admin: SupabaseClient,
  userId: string,
  _siteId?: string | null,
): Promise<number> {
  try {
    const { data } = await admin
      .from("rules_config")
      .select("revenue_share_pct")
      .eq("user_id", userId)
      .maybeSingle();
    const v = Number((data as any)?.revenue_share_pct);
    if (Number.isFinite(v) && v >= 0 && v < 100) return v;
  } catch { /* ignore */ }
  return DEFAULT_REV_SHARE_PCT;
}

export async function getNetFactor(
  admin: SupabaseClient,
  userId: string,
  siteId?: string | null,
): Promise<number> {
  const pct = await getRevSharePct(admin, userId, siteId);
  return 1 - pct / 100;
}
