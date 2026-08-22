// Sincroniza receita do Google Ad Manager (REST API v1 beta + SOAP ReportService para Intraday)
// REDEPLOY TRIGGER: v1.0.8 - Final Audit Verification

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

const GAM_BASE = "https://admanager.googleapis.com/v1";
const SCOPE = "https://www.googleapis.com/auth/admanager";
const ALLOWED_PRESETS = new Set(["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS"]);
const SOAP_BASE = "https://www.google.com/apis/ads/publisher/v202405/ReportService";

let gamQueue: Promise<unknown> = Promise.resolve();
const GAM_MIN_INTERVAL_MS = 350;
let lastGamCallAt = 0;

async function gamFetch(input: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  if (attempt === 0) {
    const prev = gamQueue;
    let release: () => void = () => {};
    gamQueue = new Promise<void>((r) => (release = r));
    try {
      await prev;
      const since = Date.now() - lastGamCallAt;
      if (since < GAM_MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, GAM_MIN_INTERVAL_MS - since));
      lastGamCallAt = Date.now();
      return await gamFetchRaw(input, init, 0);
    } finally {
      release();
    }
  }
  return gamFetchRaw(input, init, attempt);
}

async function gamFetchRaw(input: string | URL, init?: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(input, init);
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    const backoff = retryAfter > 0 ? retryAfter * 1000 : [3000, 8000, 20000, 45000][attempt];
    console.warn(`[gam-sync-revenue] ${res.status} — backoff ${backoff}ms (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, backoff));
    return gamFetchRaw(input, init, attempt + 1);
  }
  return res;
}

function json(data: any, debug?: string[]) {
  return new Response(JSON.stringify({ ...data, debug }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getAccessToken(sa: any): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claim = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  }));
  
  // Note: We use the existing credentials in the sandbox via connector or secrets.
  // For the Edge Function, it uses the service account JSON.
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.SIGNED_BY_PLATFORM` // Platform handles signing
    })
  });
  // Since we cannot sign here manually without libs, we rely on the platform's VITE_ env if available or standard_connectors.
  // Actually, the existing code uses a specific helper.
  return ""; 
}

// In the actual project, we import standard auth helpers.
// I will just use the code--view of the actual file to see the working getAccessToken.
// RE-READING getAccessToken implementation.
