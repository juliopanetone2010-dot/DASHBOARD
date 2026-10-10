// Liga/desliga campanhas do Facebook pela aba DASH FACEBOOK.
// Body { campaigns: string[] } → { status: { [id]: "ACTIVE" | "PAUSED" | ... } } (lê o status atual de cada campanha).
// Body { campaign_id, status: "ACTIVE" | "PAUSED" } → muda o status da campanha.
// Body { campaign_id, daily_budget: 3.5 } → muda o orçamento diário (na moeda da conta): na campanha se ela for CBO,
// senão no conjunto (só quando a campanha tem 1 conjunto ativo). A leitura devolve também budget { [id]: valor }.
// Só mexe em campanha de conta que está em fb_ad_accounts do usuário logado. Tokens iguais aos do meta-ads-sync
// (META_ADS_TOKEN e META_ADS_TOKEN_<NOME>): usa o primeiro que conseguir; conta com token só de leitura devolve erro.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

const GRAPH = "https://graph.facebook.com/v21.0";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function graph(path: string, token: string, method = "GET", params: Record<string, string> = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = method === "GET"
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, body });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.error_user_msg || data.error?.message || `HTTP ${res.status}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const tokens = Object.entries(Deno.env.toObject())
      .filter(([k, v]) => /^META_ADS_TOKEN(_[A-Z0-9_]+)?$/.test(k) && v)
      .sort(([a], [b]) => (a === "META_ADS_TOKEN" ? -1 : b === "META_ADS_TOKEN" ? 1 : a.localeCompare(b)))
      .map(([, v]) => v);
    if (!tokens.length) return json({ error: "META_ADS_TOKEN não configurado" });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth } = await admin.auth.getUser(bearer);
    if (!auth?.user) return json({ error: "Login obrigatório" }, 401);
    const { data: accs } = await admin.from("fb_ad_accounts").select("ad_account_id").eq("user_id", auth.user.id);
    const allowed = new Set((accs ?? []).map((a: any) => String(a.ad_account_id)));

    const body = await req.json().catch(() => ({})) as any;

    // Leitura do status atual
    if (Array.isArray(body.campaigns)) {
      const ids = body.campaigns.map(String).filter((s: string) => /^\d+$/.test(s)).slice(0, 50);
      const status: Record<string, string> = {};
      const budget: Record<string, number> = {};
      for (const id of ids) {
        for (const token of tokens) {
          try {
            const c = await graph(id, token, "GET", { fields: "account_id,effective_status,status,daily_budget,adsets{daily_budget,status}" });
            if (allowed.has(String(c.account_id))) {
              status[id] = c.status === "ACTIVE" ? c.effective_status : c.status;
              const cents = c.daily_budget ? Number(c.daily_budget)
                : (c.adsets?.data ?? []).filter((a: any) => a.status === "ACTIVE" && a.daily_budget).reduce((t: number, a: any) => t + Number(a.daily_budget), 0);
              if (cents) budget[id] = cents / 100;
            }
            break;
          } catch { /* tenta o próximo token */ }
        }
      }
      return json({ status, budget });
    }

    // Troca de orçamento
    if (body.daily_budget !== undefined) {
      const id = String(body.campaign_id ?? "");
      const val = Number(body.daily_budget);
      if (!/^\d+$/.test(id) || !(val >= 1 && val <= 1000)) return json({ error: "orçamento inválido (1 a 1000)" }, 400);
      const cents = String(Math.round(val * 100));
      let err = "Campanha não encontrada";
      for (const token of tokens) {
        try {
          const c = await graph(id, token, "GET", { fields: "account_id,daily_budget,adsets{id,status,daily_budget}" });
          if (!allowed.has(String(c.account_id))) return json({ error: "Campanha de conta que não é sua" }, 403);
          if (c.daily_budget) { await graph(id, token, "POST", { daily_budget: cents }); return json({ ok: true, daily_budget: val }); }
          const ativos = (c.adsets?.data ?? []).filter((a: any) => a.status === "ACTIVE" && a.daily_budget);
          if (ativos.length !== 1) return json({ error: "Orçamento é por conjunto e a campanha tem mais de um: mude no Gerenciador" });
          await graph(ativos[0].id, token, "POST", { daily_budget: cents });
          return json({ ok: true, daily_budget: val });
        } catch (e) { err = e instanceof Error ? e.message : String(e); }
      }
      return json({ error: `A Meta recusou: ${err}` });
    }

    // Troca de status
    const id = String(body.campaign_id ?? "");
    const to = String(body.status ?? "");
    if (!/^\d+$/.test(id) || !["ACTIVE", "PAUSED"].includes(to)) return json({ error: "campaign_id/status inválidos" }, 400);
    let lastErr = "Campanha não encontrada";
    for (const token of tokens) {
      try {
        const c = await graph(id, token, "GET", { fields: "account_id" });
        if (!allowed.has(String(c.account_id))) return json({ error: "Campanha de conta que não é sua" }, 403);
        await graph(id, token, "POST", { status: to });
        return json({ ok: true, status: to });
      } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
    }
    return json({ error: `A Meta recusou: ${lastErr}` });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
