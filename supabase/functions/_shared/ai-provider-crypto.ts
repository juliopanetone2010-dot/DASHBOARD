// AES-GCM helpers para criptografar API keys de providers IA externos.
// Chave derivada do SUPABASE_SERVICE_ROLE_KEY (sempre presente no runtime das edge functions).
// Nunca expor a key descriptografada para o cliente.

const enc = new TextEncoder();
const dec = new TextDecoder();

async function getKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const salt = enc.encode("ai_provider_configs.v1");
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("ai-provider-api-key") },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.byteLength; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptApiKey(plain: string): Promise<{ cipher: string; iv: string }> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return { cipher: b64(ct), iv: b64(iv) };
}

export async function decryptApiKey(cipher: string, iv: string): Promise<string> {
  const key = await getKey();
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(cipher));
  return dec.decode(pt);
}

export function maskApiKey(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 8) return "•".repeat(plain.length);
  return `${plain.slice(0, 4)}••••${plain.slice(-4)}`;
}
