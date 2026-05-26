// Espelho frontend de supabase/functions/_shared/normalize_url.ts
export function normalizePushUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  try { s = decodeURIComponent(s); } catch { /* ignore */ }
  s = s.toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  const qIdx = s.indexOf("?");
  if (qIdx >= 0) s = s.slice(0, qIdx);
  const hIdx = s.indexOf("#");
  if (hIdx >= 0) s = s.slice(0, hIdx);
  s = s.replace(/\/{2,}/g, "/");
  s = s.replace(/\/+$/, "");
  return s;
}
