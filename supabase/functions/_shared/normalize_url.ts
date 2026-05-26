// Normaliza URLs de páginas para match exato no relatório de Push/Retenção.
// Regras: lowercase, sem protocolo, sem www, sem query/anchor, sem trailing slash.
// Mantém o slug. Decode URI quando possível.
export function normalizePushUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";

  // Tenta decodificar (tolerante a erros)
  try { s = decodeURIComponent(s); } catch { /* keep as-is */ }

  s = s.toLowerCase();

  // Remove protocolo
  s = s.replace(/^https?:\/\//, "");

  // Remove www.
  s = s.replace(/^www\./, "");

  // Remove query/anchor
  const qIdx = s.indexOf("?");
  if (qIdx >= 0) s = s.slice(0, qIdx);
  const hIdx = s.indexOf("#");
  if (hIdx >= 0) s = s.slice(0, hIdx);

  // Collapse múltiplos // (exceto no início, mas como removemos protocolo, ok)
  s = s.replace(/\/{2,}/g, "/");

  // Remove trailing slash (mantém raiz "host")
  s = s.replace(/\/+$/, "");

  return s;
}

// Identifica linhas agregadas que NÃO devem entrar na tabela por URL.
export function isAggregateUrl(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const s = String(raw).trim().toLowerCase();
  if (!s) return true;
  if (s === "(not set)" || s === "__aggregate__" || s === "aggregate") return true;
  if (s === "n/a" || s === "null" || s === "undefined") return true;
  // URL precisa ter pelo menos um ponto (host) OU começar com /
  if (!/[./]/.test(s)) return true;
  return false;
}

// Parse simples de CUSTOM_CRITERIA do GAM ("utm_source=push;utm_campaign=...")
export function parseCustomCriteria(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of String(raw).split(/[;,]/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}
