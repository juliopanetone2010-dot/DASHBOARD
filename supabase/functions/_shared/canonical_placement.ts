// ============================================================================
// Canonical UTM Placement Parser
// ----------------------------------------------------------------------------
// SOURCE OF TRUTH para attribution de placements.
//
// Padrão oficial UTM:
//   utm_source=google
//   utm_campaign={campaignid}
//   utm_adgroup={adgroupid}
//   utm_content={creative}
//   utm_placement={campaignid}_{placement}    <-- ESTA É A CHAVE
//
// Exemplo de utm_placement válido:
//   23847634986_accuweather.com
//
// Hierarquia de reconciliação + confidence:
//   exact_utm_placement     -> 100
//   campaign_placement      -> 95   (campaign_id + placement vindos separados)
//   normalized_url          -> 70   (URL normalizada como host)
//   inferred                -> 40   (domain contains, fallback)
// ============================================================================

export type ReconciliationMethod =
  | "exact_utm_placement"
  | "campaign_placement"
  | "normalized_url"
  | "inferred"
  | "unknown";

export interface CanonicalPlacement {
  canonical_key: string;        // `${campaign_id}_${normalized_placement}`
  campaign_id: string;
  placement: string;            // valor original (ex: accuweather.com ou https://...)
  normalized_placement: string; // host minúsculo sem www
  confidence: number;           // 0..100
  reconciliation_method: ReconciliationMethod;
  broken_tracking: boolean;
  raw_utm_placement: string | null;
}

const CAMPAIGN_ID_RE = /^[0-9]{6,15}$/;

export function normalizePlacement(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input).trim();
  if (!s) return "";
  // decode percent-encoded chars
  try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
  s = s.toLowerCase();
  // strip protocol
  s = s.replace(/^https?:\/\//, "");
  // strip anchors
  s = s.split("#")[0];
  // strip query
  s = s.split("?")[0];
  // strip path (host only — canonical-key compat)
  s = s.split("/")[0];
  // collapse whitespace
  s = s.replace(/\s+/g, "");
  // strip leading www.
  s = s.replace(/^www\./, "");
  // strip trailing dots
  s = s.replace(/\.+$/, "");
  return s;
}

/**
 * Parse `utm_placement` no formato canônico:
 *   {campaignid}_{placement}
 *
 * Retorna null se formato inválido (BROKEN TRACKING).
 */
export function parseCanonicalPlacement(utmPlacement: string | null | undefined): CanonicalPlacement | null {
  if (!utmPlacement || typeof utmPlacement !== "string") return null;
  const raw = utmPlacement.trim();
  if (!raw) return null;

  const idx = raw.indexOf("_");
  if (idx <= 0 || idx === raw.length - 1) return null;

  const campaignId = raw.slice(0, idx).trim();
  const placementRaw = raw.slice(idx + 1).trim();
  if (!CAMPAIGN_ID_RE.test(campaignId) || !placementRaw) return null;

  const normalized = normalizePlacement(placementRaw);
  if (!normalized) return null;

  return {
    canonical_key: `${campaignId}_${normalized}`,
    campaign_id: campaignId,
    placement: placementRaw,
    normalized_placement: normalized,
    confidence: 100,
    reconciliation_method: "exact_utm_placement",
    broken_tracking: false,
    raw_utm_placement: raw,
  };
}

/**
 * Extrai `utm_placement=...` de uma string de UTMs / URL / raw_utm do GAM.
 */
export function extractUtmPlacementFromRaw(rawUtm: string | null | undefined): string | null {
  if (!rawUtm || typeof rawUtm !== "string") return null;
  const m = rawUtm.match(/utm_placement=([^&\s|;]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Tentativa hierárquica de reconciliação de uma row do GAM.
 *
 * Inputs típicos:
 *   - rawUtm       (string contendo utm_placement=...)
 *   - campaignId   (vindo separado em outra coluna)
 *   - placement    (vindo separado — pode ser URL ou host)
 */
export function reconcileRow(args: {
  rawUtm?: string | null;
  campaignId?: string | null;
  placement?: string | null;
}): CanonicalPlacement {
  // 1) exact via utm_placement
  const utm = extractUtmPlacementFromRaw(args.rawUtm);
  const parsed = parseCanonicalPlacement(utm);
  if (parsed) return parsed;

  const cid = (args.campaignId ?? "").trim();
  const plRaw = (args.placement ?? "").trim();
  const normalized = normalizePlacement(plRaw);

  // 2) campaign_id + placement
  if (CAMPAIGN_ID_RE.test(cid) && normalized) {
    return {
      canonical_key: `${cid}_${normalized}`,
      campaign_id: cid,
      placement: plRaw,
      normalized_placement: normalized,
      confidence: 95,
      reconciliation_method: "campaign_placement",
      broken_tracking: false,
      raw_utm_placement: utm ?? null,
    };
  }

  // 3) normalized URL apenas
  if (normalized) {
    return {
      canonical_key: `unknown_${normalized}`,
      campaign_id: cid || "unknown",
      placement: plRaw,
      normalized_placement: normalized,
      confidence: 70,
      reconciliation_method: "normalized_url",
      broken_tracking: !utm,
      raw_utm_placement: utm ?? null,
    };
  }

  // 4) inferred / broken
  return {
    canonical_key: `broken_${cid || "unknown"}_${plRaw || "empty"}`,
    campaign_id: cid || "unknown",
    placement: plRaw || "",
    normalized_placement: normalized,
    confidence: 40,
    reconciliation_method: "inferred",
    broken_tracking: true,
    raw_utm_placement: utm ?? null,
  };
}
