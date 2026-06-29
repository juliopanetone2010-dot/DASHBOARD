// Gera snapshot financeiro fechado por site/dia.
// - Por padrão: snapshot do dia anterior (rodado pelo cron 00:05 BRT).
// - Pode receber { date: "YYYY-MM-DD", site_id?: string, force?: boolean } para regenerar.
// - Snapshots são imutáveis: se já existe e force!=true, não sobrescreve.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const REV_SHARE_PCT = 0.065;
const NET_FACTOR = 1 - REV_SHARE_PCT;

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function yesterdayBRT(): string {
  // 00:05 BRT (UTC-3) → ainda é "ontem" em UTC. Subtrai 3h para virar BRT, depois -1d.
  const brt = new Date(Date.now() - 3 * 3600_000);
  brt.setUTCDate(brt.getUTCDate() - 1);
  return ymd(brt);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const targetDate: string = typeof body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : yesterdayBRT();
    const requestedSiteId: string | null = typeof body?.site_id === "string" ? body.site_id : null;
    const force: boolean = Boolean(body?.force);
    const requestedUserId: string | null = typeof body?.user_id === "string" ? body.user_id : null;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Cotação USD→BRL (cache simples)
    const usdBrl = await getUsdBrl();

    // Lista todos os sites (cron roda como service-role; gera para todos os usuários)
    let sitesQuery = admin
      .from("sites")
      .select("id, user_id, name, gam_currency");
    if (requestedSiteId) sitesQuery = sitesQuery.eq("id", requestedSiteId);
    if (requestedUserId) sitesQuery = sitesQuery.eq("user_id", requestedUserId);
    const { data: sites, error: sErr } = await sitesQuery;
    if (sErr) throw sErr;

    const results: any[] = [];

    // Antes de gerar snapshots, força sync do GAM para targetDate (garante dados frescos
    // mesmo se o GAM ainda não fechou o dia anterior na 1ª passada do cron 04:00).
    for (const site of sites ?? []) {
      try {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/gam-sync-revenue`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            site_id: site.id,
            user_id: site.user_id,
            from: targetDate,
            to: targetDate,
            revenue_only: true,
            site_metrics_only: true,
            sync: true,
            skip_viewability: false,
            skip_snapshot_regen: true,
          }),
        });
      } catch (e) {
        console.warn("[snapshot] gam-sync pre-call failed", site.name, String(e));
      }
    }

    for (const site of sites ?? []) {
      try {
        // Skip se já existe e não é force — MAS regera se a parte de receita/impressões está zerada
        // (provavelmente criado antes do GAM ter sincronizado os dados do dia).
        // Não usamos total_cost nessa checagem: o custo do Google Ads pode chegar antes da receita GAM,
        // e o snapshot precisa ser atualizado automaticamente quando a receita aparecer depois.
        // Sempre regera o snapshot do dia corrente (BRT) para refletir a receita acumulada
        // — caso contrário, o calendário trava no valor da primeira execução do dia.
        const todayBrt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const isTodayBrt = targetDate === todayBrt;
        if (!force && !isTodayBrt) {
          const { data: existing } = await admin
            .from("daily_financial_snapshots")
            .select("id, gross_revenue, impressions")
            .eq("user_id", site.user_id)
            .eq("site_id", site.id)
            .eq("date", targetDate)
            .maybeSingle();
          if (existing) {
            const hasRevenueSnapshot = Number(existing.gross_revenue ?? 0) > 0 || Number(existing.impressions ?? 0) > 0;
            if (hasRevenueSnapshot) {
              results.push({ site: site.name, date: targetDate, status: "skipped_existing" });
              continue;
            }
            // se a receita/impressões estão zeradas, deixa seguir para regenerar com dados frescos
          }
        }

        // 1) Custo Google Ads do dia (BRL nativo) — via account_site_links
        const { data: links } = await admin
          .from("account_site_links")
          .select("google_account_id")
          .eq("site_id", site.id);
        const accIds = (links ?? []).map((l: any) => l.google_account_id);

        let googleAdsCost = 0;
        let clicks = 0;
        let conversions = 0;

        if (accIds.length > 0) {
          // Conta quantos sites cada conta serve para ratear
          const { data: allLinks } = await admin
            .from("account_site_links")
            .select("google_account_id, site_id")
            .in("google_account_id", accIds);
          const sitesPerAcc = new Map<string, number>();
          for (const l of allLinks ?? []) {
            sitesPerAcc.set(l.google_account_id, (sitesPerAcc.get(l.google_account_id) ?? 0) + 1);
          }

          const { data: dms } = await admin
            .from("daily_metrics")
            .select("google_account_id, spend, clicks, conversions")
            .eq("user_id", site.user_id)
            .in("google_account_id", accIds)
            .eq("date", targetDate);

          for (const r of dms ?? []) {
            const share = 1 / (sitesPerAcc.get(r.google_account_id) ?? 1);
            googleAdsCost += (Number(r.spend) || 0) * share;
            clicks += Math.round((Number(r.clicks) || 0) * share);
            conversions += (Number(r.conversions) || 0) * share;
          }
        }

        // 2) Receita GAM bruta + impressões/eCPM/viewability — via site_metrics_daily (nativo)
        // A métrica de receita que vem do GAM/API é bruta; para a dashboard/calendário
        // usamos a receita líquida do publisher, aplicando uma única vez -6,5%.
        const { data: smd } = await admin
          .from("site_metrics_daily")
          .select("impressions, measurable_impressions, viewable_impressions, revenue_native, currency, ecpm_native")
          .eq("user_id", site.user_id)
          .eq("site_id", site.id)
          .eq("date", targetDate)
          .maybeSingle();

        const currency = String(smd?.currency ?? site.gam_currency ?? "USD").toUpperCase();
        let grossNative = Number(smd?.revenue_native ?? 0);
        const grossBrl = currency === "BRL" ? grossNative : grossNative * usdBrl;
        const impressions = Number(smd?.impressions ?? 0);
        const measurable = Number(smd?.measurable_impressions ?? 0);
        const viewable = Number(smd?.viewable_impressions ?? 0);

        // Correção defensiva: alguns reports antigos ficaram com receita em micros dividida duas vezes
        // (ex.: 1051 vira 0.001051). Quando houver impressões reais e receita absurda, usa o report
        // legado por ad_unit do mesmo site/dia, que tem o valor nativo correto.
        if (impressions > 1000 && grossNative > 0 && grossNative < 1) {
          const { data: legacyRows } = await admin
            .from("placements")
            .select("revenue")
            .eq("user_id", site.user_id)
            .eq("site_id", site.id)
            .eq("date", targetDate)
            .not("ad_unit", "is", null);
          const legacyRevenue = (legacyRows ?? []).reduce((sum: number, r: any) => sum + (Number(r.revenue) || 0), 0);
          if (legacyRevenue > 1) grossNative = legacyRevenue;
        }

        // Receita armazenada na MOEDA NATIVA do GAM (USD ou BRL).
        // gross_revenue = bruto do GAM; net_revenue = bruto -6,5%.
        // Custos/lucro/eCPM continuam em BRL para reconciliação.
        const grossNativeFinal = grossNative;
        const netNative = grossNativeFinal * NET_FACTOR;
        const correctedGrossBrl = currency === "BRL" ? grossNativeFinal : grossNativeFinal * usdBrl;
        const revenueAfterRevshareBrl = correctedGrossBrl * NET_FACTOR;
        const viewability = measurable > 0 ? (viewable / measurable) * 100 : 0;
        const ecpm = impressions > 0 ? (revenueAfterRevshareBrl / impressions) * 1000 : 0;

        const facebookAdsCost = 0; // placeholder até integração FB
        const otherCost = 0;
        const taxes = 0;
        const fixedCost = 0;
        const totalCost = googleAdsCost + facebookAdsCost + otherCost + taxes + fixedCost;
        const liquidProfit = revenueAfterRevshareBrl - totalCost;
        const profitMargin = revenueAfterRevshareBrl > 0 ? (liquidProfit / revenueAfterRevshareBrl) * 100 : 0;

        const payload = {
          user_id: site.user_id,
          site_id: site.id,
          date: targetDate,
          google_ads_cost: round2(googleAdsCost),
          facebook_ads_cost: round2(facebookAdsCost),
          other_cost: round2(otherCost),
          total_cost: round2(totalCost),
          // gross/net armazenados na moeda nativa do GAM (USD ou BRL)
          gross_revenue: round2(grossNativeFinal),
          net_revenue: round2(netNative),
          adsense_revenue: null,
          adx_revenue: null,
          revenue_after_revshare: round2(revenueAfterRevshareBrl),
          taxes: round2(taxes),
          fixed_cost: round2(fixedCost),
          liquid_profit: round2(liquidProfit),
          profit_margin_pct: round2(profitMargin),
          ecpm: round2(ecpm),
          viewability: round2(viewability),
          impressions,
          clicks,
          conversions: round2(conversions),
          currency: "BRL",
          revenue_currency: currency,
        };

        await admin
          .from("daily_financial_snapshots")
          .upsert(payload, { onConflict: "user_id,site_id,date" });

        results.push({ site: site.name, date: targetDate, status: force ? "regenerated" : "created", profit: payload.liquid_profit });
      } catch (e) {
        results.push({ site: site.name, date: targetDate, error: String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, date: targetDate, count: results.length, results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[generate-daily-snapshot]", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function round2(n: number) { return Math.round((n || 0) * 100) / 100; }

async function getUsdBrl(): Promise<number> {
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const j = await r.json();
    const v = Number(j?.rates?.BRL);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* ignore */ }
  return 4.97;
}
