// Resolve credenciais do Google Ads por "API set" (conjunto de credenciais / MCC).
//
// api_set = 1 -> GOOGLE_CLIENT_ID_1 ... com fallback para GOOGLE_CLIENT_ID (legado)
// api_set = 2 -> GOOGLE_CLIENT_ID_2 / GOOGLE_CLIENT_SECRET_2 / GOOGLE_ADS_DEVELOPER_TOKEN_2
// api_set = N -> ..._N
//
// Assim a MCC antiga continua rodando com os secrets atuais e novas MCCs
// podem ser cadastradas em conjuntos separados.

export interface GoogleAdsCreds {
  clientId: string;
  clientSecret: string;
  devToken: string;
  apiSet: number;
}

const env = (k: string) => Deno.env.get(k) ?? "";

export function normalizeApiSet(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function pick(base: string, apiSet: number): string {
  const suffixed = env(`${base}_${apiSet}`);
  if (suffixed) return suffixed;
  // fallback legado somente para o conjunto 1
  return apiSet === 1 ? env(base) : "";
}

/** Retorna as credenciais do conjunto informado (lança se faltar algo). */
export function getCreds(apiSetRaw: unknown = 1): GoogleAdsCreds {
  const apiSet = normalizeApiSet(apiSetRaw);
  const clientId = pick("GOOGLE_CLIENT_ID", apiSet);
  const clientSecret = pick("GOOGLE_CLIENT_SECRET", apiSet);
  const devToken = pick("GOOGLE_ADS_DEVELOPER_TOKEN", apiSet);
  if (!clientId || !clientSecret || !devToken) {
    throw new Error(
      `Credenciais Google Ads do conjunto ${apiSet} não configuradas (GOOGLE_CLIENT_ID_${apiSet} / GOOGLE_CLIENT_SECRET_${apiSet} / GOOGLE_ADS_DEVELOPER_TOKEN_${apiSet})`,
    );
  }
  return { clientId, clientSecret, devToken, apiSet };
}

/** Versão que não lança — útil para status/diagnóstico. */
export function tryGetCreds(apiSetRaw: unknown = 1): GoogleAdsCreds | null {
  try {
    return getCreds(apiSetRaw);
  } catch {
    return null;
  }
}

export const MAX_API_SETS = 5;

/** Lista quais conjuntos (1..MAX_API_SETS) estão configurados. */
export function listApiSets() {
  const out: Array<{
    api_set: number;
    client_id: boolean;
    client_secret: boolean;
    developer_token: boolean;
    configured: boolean;
  }> = [];
  for (let i = 1; i <= MAX_API_SETS; i++) {
    const client_id = !!pick("GOOGLE_CLIENT_ID", i);
    const client_secret = !!pick("GOOGLE_CLIENT_SECRET", i);
    const developer_token = !!pick("GOOGLE_ADS_DEVELOPER_TOKEN", i);
    out.push({
      api_set: i,
      client_id,
      client_secret,
      developer_token,
      configured: client_id && client_secret && developer_token,
    });
  }
  return out;
}

/** Troca refresh_token por access_token usando o conjunto correto. */
export async function getAccessTokenFor(
  refreshToken: string,
  apiSetRaw: unknown = 1,
): Promise<string> {
  const { clientId, clientSecret } = getCreds(apiSetRaw);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error(`Falha ao renovar access_token: ${JSON.stringify(j)}`);
  }
  return j.access_token as string;
}

/** Developer token do conjunto (sem lançar; string vazia se ausente). */
export function devTokenFor(apiSetRaw: unknown = 1): string {
  return pick("GOOGLE_ADS_DEVELOPER_TOKEN", normalizeApiSet(apiSetRaw));
}
