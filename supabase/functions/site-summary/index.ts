// Endpoint público: GET /site-summary?site=<slug|name|domain>
// Retorna [{ site, cost, revenue }] agregando até ONTEM (timezone America/Sao_Paulo).
// - cost: spend do daily_metrics (Google Ads, BRL nativo)
// - revenue: revenue do daily_metrics (GAM, USD bruto, SEM revshare)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function normalize(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function yesterdayISO() {
  // America/Sao_Paulo (UTC-3, sem DST hoje)
  const now = new Date(Date.now() - 3 * 3600_000);
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const url = new URL(req.url);
    const siteParam = url.searchParams.get("site")?.trim() || "";

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: sites, error: sErr } = await admin
      .from("sites")
      .select("id, name, domain, user_id");
    if (sErr) return json({ error: sErr.message }, 500);

    let filtered = sites ?? [];
    if (siteParam) {
      const target = normalize(siteParam);
      filtered = filtered.filter((s) =>
        normalize(s.name).includes(target) ||
        normalize(s.domain).includes(target)
      );
      if (filtered.length === 0) return json([], 200);
    }

    const to = yesterdayISO();
    const from = "2000-01-01";

    // Carrega links site -> google_account
    const siteIds = filtered.map((s) => s.id);
    const { data: links } = await admin
      .from("account_site_links")
      .select("site_id, google_account_id")
      .in("site_id", siteIds);

    // Map google_account -> sites
    const accToSites = new Map<string, string[]>();
    for (const l of links ?? []) {
      const arr = accToSites.get(l.google_account_id) ?? [];
      arr.push(l.site_id);
      accToSites.set(l.google_account_id, arr);
    }

    // 1) Custo: daily_metrics agregado por google_account_id
    const accIds = [...accToSites.keys()];
    const costBySite = new Map<string, number>();
    if (accIds.length > 0) {
      // paginar para evitar limite de 1000
      let offset = 0;
      const pageSize = 1000;
      const sumByAcc = new Map<string, number>();
      while (true) {
        const { data, error } = await admin
          .from("daily_metrics")
          .select("google_account_id, spend, date")
          .in("google_account_id", accIds)
          .lte("date", to)
          .range(offset, offset + pageSize - 1);
        if (error) return json({ error: error.message }, 500);
        if (!data || data.length === 0) break;
        for (const r of data) {
          const k = String(r.google_account_id);
          sumByAcc.set(k, (sumByAcc.get(k) ?? 0) + (Number(r.spend) || 0));
        }
        if (data.length < pageSize) break;
        offset += pageSize;
      }
      // Distribui custo da conta entre os sites vinculados (rateio igual se múltiplos)
      for (const [accId, total] of sumByAcc) {
        const sIds = accToSites.get(accId) ?? [];
        if (sIds.length === 0) continue;
        const share = total / sIds.length;
        for (const sid of sIds) {
          costBySite.set(sid, (costBySite.get(sid) ?? 0) + share);
        }
      }
    }

    // 2) Receita: gam_placement_revenue por site_id (USD bruto, sem revshare)
    const revBySite = new Map<string, number>();
    if (siteIds.length > 0) {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await admin
          .from("gam_placement_revenue")
          .select("site_id, revenue_usd, date")
          .in("site_id", siteIds)
          .lte("date", to)
          .range(offset, offset + pageSize - 1);
        if (error) return json({ error: error.message }, 500);
        if (!data || data.length === 0) break;
        for (const r of data) {
          if (!r.site_id) continue;
          const k = String(r.site_id);
          revBySite.set(k, (revBySite.get(k) ?? 0) + (Number(r.revenue_usd) || 0));
        }
        if (data.length < pageSize) break;
        offset += pageSize;
      }
    }

    const result = filtered.map((s) => ({
      site: s.name,
      domain: s.domain,
      cost: round2(costBySite.get(s.id) ?? 0),
      revenue: round2(revBySite.get(s.id) ?? 0),
    }));

    return json(result, 200);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function json(p: unknown, status = 200) {
  return new Response(JSON.stringify(p), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
