// Retorna a última hora com impressões no GOOGLE ADS pra hoje — mesma info que
// aparece em "Visão geral > Dia e hora" na própria UI do Google Ads, só que
// agregada pras contas vinculadas ao site escolhido na dash.
// Companheiro do gam-last-hour (que faz o mesmo pro lado do Ad Manager).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { getAccessTokenFor, devTokenFor } from "../_shared/google_api_set.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Login obrigatório" });

    const body = await req.json().catch(() => ({}));
    const date: string = typeof (body as any)?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test((body as any).date)
      ? (body as any).date
      : new Date().toISOString().slice(0, 10);
    const requestedSiteId: string | null = typeof (body as any)?.site_id === "string" ? (body as any).site_id : null;

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: claims } = await userClient.auth.getClaims(authHeader.replace("Bearer ", ""));
    const userId = claims?.claims?.sub;
    if (!userId) return json({ error: "Token inválido" });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let accountIds: string[];
    if (requestedSiteId && requestedSiteId !== "all") {
      const { data: links } = await admin
        .from("account_site_links")
        .select("google_account_id")
        .eq("user_id", userId)
        .eq("site_id", requestedSiteId);
      accountIds = [...new Set((links ?? []).map((l: { google_account_id: string }) => l.google_account_id))];
    } else {
      const { data: accs } = await admin.from("google_accounts").select("id").eq("user_id", userId);
      accountIds = (accs ?? []).map((a: { id: string }) => a.id);
    }
    if (accountIds.length === 0) return json({ ok: true, date, lastHour: null, status: "no_account" });

    const { data: accounts } = await admin
      .from("google_accounts")
      .select("id, customer_id, refresh_token, login_customer_id, api_set, account_name, descriptive_name, is_mcc")
      .in("id", accountIds);
    const targets = (accounts ?? []).filter((a: any) => a.refresh_token && a.customer_id && !a.is_mcc);
    if (targets.length === 0) return json({ ok: true, date, lastHour: null, status: "no_operational_account" });

    const hourMap = new Map<number, number>();
    const debugRows: any[] = [];

    // Cada conta isolada em try/catch — uma conta com problema de acesso não pode
    // derrubar o resultado das outras (mesma lição do placements-cleanup).
    await Promise.all(targets.map(async (acc: any) => {
      const label = acc.account_name || acc.descriptive_name || acc.customer_id;
      try {
        const apiSet = acc.api_set ?? 1;
        const accessToken = await getAccessTokenFor(acc.refresh_token, apiSet);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${accessToken}`,
          "developer-token": devTokenFor(apiSet),
          "Content-Type": "application/json",
        };
        if (acc.login_customer_id) headers["login-customer-id"] = acc.login_customer_id;

        const query = `
          SELECT segments.hour, metrics.impressions
          FROM customer
          WHERE segments.date = '${date}'
        `;
        const r = await fetch(`https://googleads.googleapis.com/v24/customers/${acc.customer_id}/googleAds:search`, {
          method: "POST", headers, body: JSON.stringify({ query }),
        });
        const j = await r.json();
        if (!r.ok) { debugRows.push({ account: label, error: j?.error?.message ?? JSON.stringify(j).slice(0, 300) }); return; }
        const rows = (j.results ?? []) as Array<{ segments?: { hour?: number }; metrics?: { impressions?: string | number } }>;
        let accountTotal = 0;
        for (const row of rows) {
          const hour = Number(row.segments?.hour);
          const impr = Number(row.metrics?.impressions ?? 0);
          if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
          hourMap.set(hour, (hourMap.get(hour) ?? 0) + impr);
          accountTotal += impr;
        }
        debugRows.push({ account: label, rows: rows.length, impressions: accountTotal });
      } catch (e) {
        debugRows.push({ account: label, error: String(e instanceof Error ? e.message : e) });
      }
    }));

    const hours = [...hourMap.entries()]
      .map(([hour, impressions]) => ({ hour, impressions }))
      .sort((a, b) => a.hour - b.hour);
    const hoursWithData = hours.filter((h) => h.impressions > 0);
    const maxHour = hoursWithData.length > 0 ? Math.max(...hoursWithData.map((h) => h.hour)) : -1;
    const totalImpr = hours.reduce((s, h) => s + h.impressions, 0);

    const label = maxHour < 0
      ? "Sem impressões do Google Ads ainda hoje"
      : `Google Ads atualizado até: ${String(maxHour).padStart(2, "0")}:59`;

    return json({
      ok: true,
      date,
      lastHour: maxHour >= 0 ? maxHour : null,
      totalImpressions: totalImpr,
      hours,
      label,
      debug: debugRows,
    });
  } catch (e) {
    console.error("[ads-last-hour] uncaught", e);
    return json({ error: String(e instanceof Error ? e.message : e) });
  }
});
