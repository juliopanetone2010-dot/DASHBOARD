// Gasto do Facebook (Meta Ads) por anúncio e por dia → fb_ad_daily.
// Chamado pelo cron (meta-ads-sync-hourly, bearer service_role: todas as contas ativas) e pelo botão
// "Sincronizar" da aba Facebook (JWT do usuário: só as contas dele). Body opcional: { days?: number }.
// Tokens: secrets META_ADS_TOKEN e META_ADS_TOKEN_<NOME>, um usuário do sistema por BM com ads_read. A receita não vem daqui:
// fica em gam_campaign_source_revenue (utm_campaign = ID da campanha do Facebook), ver a migration 20261008120000.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

const GRAPH = "https://graph.facebook.com/v21.0";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface InsightRow {
  date_start: string;
  campaign_id: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
}

async function fetchInsights(adAccountId: string, token: string, since: string, until: string): Promise<InsightRow[]> {
  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,inline_link_clicks,actions",
    limit: "500",
    access_token: token,
  });
  let url: string | null = `${GRAPH}/act_${adAccountId}/insights?${params}`;
  const out: InsightRow[] = [];
  for (let page = 0; url && page < 50; page++) {
    const res: Response = await fetch(url);
    const body: any = await res.json();
    if (!res.ok || body.error) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    out.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }
  return out;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Um token por BM: META_ADS_TOKEN (Zorvia) e META_ADS_TOKEN_<NOME> (ex.: META_ADS_TOKEN_ELISANDRA).
    // Cada conta usa o primeiro token que tiver acesso a ela.
    const tokens = Object.entries(Deno.env.toObject())
      .filter(([k, v]) => /^META_ADS_TOKEN(_[A-Z0-9_]+)?$/.test(k) && v)
      .sort(([a], [b]) => (a === "META_ADS_TOKEN" ? -1 : b === "META_ADS_TOKEN" ? 1 : a.localeCompare(b)))
      .map(([, v]) => v);
    if (!tokens.length) return json({ error: "META_ADS_TOKEN não configurado (supabase secrets set META_ADS_TOKEN=...)" });

    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    let userId: string | null = null;
    // o gateway já validou a assinatura do JWT (verify_jwt); o cron manda o service_role do Vault
    let role = "";
    try { role = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role ?? ""; } catch { /* não é JWT */ }
    if (bearer !== SERVICE_ROLE && role !== "service_role") {
      const { data } = await admin.auth.getUser(bearer);
      if (!data?.user) return json({ error: "Login obrigatório" }, 401);
      userId = data.user.id;
    }

    const body = await req.json().catch(() => ({}));
    const days = Math.min(Math.max(Number((body as any)?.days) || 3, 1), 90);
    const until = new Date();
    const since = new Date(until.getTime() - (days - 1) * 86_400_000);

    let q = admin.from("fb_ad_accounts").select("id,user_id,ad_account_id,name").eq("active", true);
    if (userId) q = q.eq("user_id", userId);
    const { data: accounts, error } = await q;
    if (error) return json({ error: error.message }, 500);

    const result: Array<{ account: string; rows?: number; error?: string }> = [];
    for (const acc of accounts ?? []) {
      try {
        // folga de 1 dia nas pontas: o dia da conta (fuso da Meta) pode não bater com o UTC daqui
        let rows: InsightRow[] | null = null;
        let lastErr: unknown = null;
        for (const token of tokens) {
          try {
            rows = await fetchInsights(acc.ad_account_id, token,
              ymd(new Date(since.getTime() - 86_400_000)), ymd(new Date(until.getTime() + 86_400_000)));
            break;
          } catch (e) { lastErr = e; }
        }
        if (!rows) throw lastErr;
        const records = rows.map((r) => ({
          user_id: acc.user_id,
          ad_account_id: acc.ad_account_id,
          date: r.date_start,
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name ?? null,
          adset_id: r.adset_id ?? null,
          adset_name: r.adset_name ?? null,
          ad_id: r.ad_id,
          ad_name: r.ad_name ?? null,
          spend: Number(r.spend ?? 0),
          impressions: Number(r.impressions ?? 0),
          link_clicks: Number(r.inline_link_clicks ?? 0),
          landing_page_views: Number(r.actions?.find((a) => a.action_type === "landing_page_view")?.value ?? 0),
          updated_at: new Date().toISOString(),
        }));
        for (let i = 0; i < records.length; i += 500) {
          const { error: upErr } = await admin.from("fb_ad_daily")
            .upsert(records.slice(i, i + 500), { onConflict: "user_id,ad_id,date" });
          if (upErr) throw new Error(upErr.message);
        }
        await admin.from("fb_ad_accounts").update({ last_sync_at: new Date().toISOString(), last_sync_error: null }).eq("id", acc.id);
        result.push({ account: acc.name ?? acc.ad_account_id, rows: records.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await admin.from("fb_ad_accounts").update({ last_sync_error: msg.slice(0, 500) }).eq("id", acc.id);
        result.push({ account: acc.name ?? acc.ad_account_id, error: msg });
      }
    }
    return json({ ok: true, days, result });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
