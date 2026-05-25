// AI Assistant contextual — usa Lovable AI Gateway por padrão, OU o provider externo
// configurado pelo usuário (DeepSeek/OpenAI/OpenRouter) via tabela ai_provider_configs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptApiKey } from "../_shared/ai-provider-crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const NET_FACTOR_DEFAULT = 0.935; // GAM revenue → líquido (rev share ~6.5%)
const OPENAI_COMPATIBLE = new Set(["deepseek", "openai", "openrouter"]);
const DEFAULT_BASE_URL: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
const DEFAULT_MODEL: Record<string, string> = {
  deepseek: "deepseek-chat",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
};

type ToolFn = (args: any, ctx: { userId: string; admin: any }) => Promise<any>;

// ------- TOOLS -------
const tools: Record<string, { def: any; run: ToolFn }> = {
  validate_placement_revenue: {
    def: {
      type: "function",
      function: {
        name: "validate_placement_revenue",
        description: "Para um placement (ou todos de uma campanha+período), retorna custo (ads_placements), revenue bruto (gam_placement_revenue), revenue líquido (após NET_FACTOR), ROI calculado, contagem de linhas por dia e sinaliza inconsistências (revenue sem custo, custo sem revenue, ROI impossível).",
        parameters: {
          type: "object",
          properties: {
            campaign_id: { type: "string" },
            placement: { type: "string", description: "opcional; se omitido, lista todos os placements da campanha" },
            from: { type: "string", description: "YYYY-MM-DD" },
            to: { type: "string", description: "YYYY-MM-DD" },
            site_id: { type: "string", description: "opcional, filtra GAM por site" },
            net_factor: { type: "number", description: `padrão ${NET_FACTOR_DEFAULT}` },
          },
          required: ["campaign_id", "from", "to"],
        },
      },
    },
    run: async (a, { userId, admin }) => {
      const nf = typeof a.net_factor === "number" ? a.net_factor : NET_FACTOR_DEFAULT;
      let adsQ = admin.from("ads_placements")
        .select("placement, date, cost, clicks, impressions")
        .eq("user_id", userId).eq("campaign_id", a.campaign_id)
        .gte("date", a.from).lte("date", a.to);
      if (a.placement) adsQ = adsQ.eq("placement", a.placement);
      let gamQ = admin.from("gam_placement_revenue")
        .select("placement, date, revenue_usd, impressions, site_id, source, utm_source")
        .eq("user_id", userId).eq("campaign_id", a.campaign_id)
        .gte("date", a.from).lte("date", a.to);
      if (a.placement) gamQ = gamQ.eq("placement", a.placement);
      if (a.site_id) gamQ = gamQ.eq("site_id", a.site_id);
      const [{ data: ads }, { data: gam }] = await Promise.all([adsQ, gamQ]);
      const byPlacement = new Map<string, any>();
      for (const r of ads ?? []) {
        const k = r.placement;
        const cur = byPlacement.get(k) ?? { placement: k, cost: 0, gross_revenue_usd: 0, clicks: 0, impressions_ads: 0, impressions_gam: 0, gam_rows: 0, sites: new Set(), sources: new Set() };
        cur.cost += Number(r.cost) || 0; cur.clicks += Number(r.clicks) || 0; cur.impressions_ads += Number(r.impressions) || 0;
        byPlacement.set(k, cur);
      }
      for (const r of gam ?? []) {
        const k = r.placement;
        const cur = byPlacement.get(k) ?? { placement: k, cost: 0, gross_revenue_usd: 0, clicks: 0, impressions_ads: 0, impressions_gam: 0, gam_rows: 0, sites: new Set(), sources: new Set() };
        cur.gross_revenue_usd += Number(r.revenue_usd) || 0;
        cur.impressions_gam += Number(r.impressions) || 0;
        cur.gam_rows += 1;
        if (r.site_id) cur.sites.add(r.site_id);
        if (r.source) cur.sources.add(r.source);
        byPlacement.set(k, cur);
      }
      const out = [...byPlacement.values()].map((r) => {
        const net = r.gross_revenue_usd * nf;
        const profit = net - r.cost;
        const roi_pct = r.cost > 0 ? (profit / r.cost) * 100 : null;
        const flags: string[] = [];
        if (r.cost > 0 && r.gross_revenue_usd === 0) flags.push("cost_without_revenue");
        if (r.cost === 0 && r.gross_revenue_usd > 0) flags.push("revenue_without_cost");
        if (r.sites.size > 1) flags.push("multiple_sites");
        if (roi_pct !== null && roi_pct > 5000) flags.push("roi_impossible");
        return {
          placement: r.placement,
          cost_usd: round(r.cost), gross_revenue_usd: round(r.gross_revenue_usd),
          net_factor: nf, net_revenue_usd: round(net), profit_usd: round(profit), roi_pct: roi_pct === null ? null : round(roi_pct),
          gam_rows: r.gam_rows, impressions_ads: r.impressions_ads, impressions_gam: r.impressions_gam,
          sites: [...r.sites], sources: [...r.sources], flags,
        };
      }).sort((a, b) => (b.cost_usd + b.gross_revenue_usd) - (a.cost_usd + a.gross_revenue_usd)).slice(0, 50);
      return { placements: out, count: out.length };
    },
  },

  detect_placement_mismatch: {
    def: {
      type: "function",
      function: {
        name: "detect_placement_mismatch",
        description: "Lista placements no período onde existe custo no Google Ads mas zero revenue no GAM (ou vice-versa). Útil para detectar UTM faltando, attribution quebrada ou placement servindo em site diferente.",
        parameters: {
          type: "object",
          properties: {
            campaign_id: { type: "string" },
            from: { type: "string" }, to: { type: "string" },
            site_id: { type: "string" },
            min_cost_usd: { type: "number", description: "ignora placements com custo abaixo (default 0.5)" },
          },
          required: ["from", "to"],
        },
      },
    },
    run: async (a, { userId, admin }) => {
      const minCost = typeof a.min_cost_usd === "number" ? a.min_cost_usd : 0.5;
      let adsQ = admin.from("ads_placements")
        .select("placement, campaign_id, campaign_name, cost").eq("user_id", userId)
        .gte("date", a.from).lte("date", a.to);
      if (a.campaign_id) adsQ = adsQ.eq("campaign_id", a.campaign_id);
      let gamQ = admin.from("gam_placement_revenue")
        .select("placement, campaign_id, revenue_usd").eq("user_id", userId)
        .gte("date", a.from).lte("date", a.to);
      if (a.campaign_id) gamQ = gamQ.eq("campaign_id", a.campaign_id);
      if (a.site_id) gamQ = gamQ.eq("site_id", a.site_id);
      const [{ data: ads }, { data: gam }] = await Promise.all([adsQ, gamQ]);
      const adsAgg = new Map<string, { cost: number; campaign_id: string; campaign_name?: string }>();
      for (const r of ads ?? []) {
        const k = `${r.campaign_id}|${r.placement}`;
        const cur = adsAgg.get(k) ?? { cost: 0, campaign_id: r.campaign_id, campaign_name: r.campaign_name };
        cur.cost += Number(r.cost) || 0; adsAgg.set(k, cur);
      }
      const gamAgg = new Map<string, number>();
      for (const r of gam ?? []) {
        const k = `${r.campaign_id}|${r.placement}`;
        gamAgg.set(k, (gamAgg.get(k) ?? 0) + (Number(r.revenue_usd) || 0));
      }
      const cost_without_revenue: any[] = [];
      const revenue_without_cost: any[] = [];
      for (const [k, v] of adsAgg.entries()) {
        if (v.cost < minCost) continue;
        if (!gamAgg.has(k) || (gamAgg.get(k) ?? 0) === 0) {
          const [campaign_id, placement] = k.split("|");
          cost_without_revenue.push({ campaign_id, campaign_name: v.campaign_name, placement, cost_usd: round(v.cost) });
        }
      }
      for (const [k, rev] of gamAgg.entries()) {
        if (!adsAgg.has(k) || (adsAgg.get(k)?.cost ?? 0) === 0) {
          const [campaign_id, placement] = k.split("|");
          revenue_without_cost.push({ campaign_id, placement, gross_revenue_usd: round(rev) });
        }
      }
      return {
        cost_without_revenue: cost_without_revenue.sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 30),
        revenue_without_cost: revenue_without_cost.sort((a, b) => b.gross_revenue_usd - a.gross_revenue_usd).slice(0, 30),
        totals: { cost_only: cost_without_revenue.length, revenue_only: revenue_without_cost.length },
      };
    },
  },

  detect_cross_site_leak: {
    def: {
      type: "function",
      function: {
        name: "detect_cross_site_leak",
        description: "Detecta placements cuja receita aparece atribuída a mais de um site no GAM no mesmo período (possível mistura ou UTM errado).",
        parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, campaign_id: { type: "string" } }, required: ["from", "to"] },
      },
    },
    run: async (a, { userId, admin }) => {
      let q = admin.from("gam_placement_revenue")
        .select("placement, campaign_id, site_id, revenue_usd, utm_source")
        .eq("user_id", userId).gte("date", a.from).lte("date", a.to);
      if (a.campaign_id) q = q.eq("campaign_id", a.campaign_id);
      const { data } = await q;
      const m = new Map<string, Map<string, number>>();
      const utmMap = new Map<string, Set<string>>();
      for (const r of data ?? []) {
        const k = `${r.campaign_id}|${r.placement}`;
        const sm = m.get(k) ?? new Map();
        sm.set(r.site_id ?? "null", (sm.get(r.site_id ?? "null") ?? 0) + (Number(r.revenue_usd) || 0));
        m.set(k, sm);
        const u = utmMap.get(k) ?? new Set(); if (r.utm_source) u.add(r.utm_source); utmMap.set(k, u);
      }
      const leaks: any[] = [];
      for (const [k, sm] of m.entries()) {
        if (sm.size > 1) {
          const [campaign_id, placement] = k.split("|");
          leaks.push({
            campaign_id, placement,
            sites: [...sm.entries()].map(([site_id, rev]) => ({ site_id, gross_revenue_usd: round(rev) })),
            utm_sources: [...(utmMap.get(k) ?? [])],
          });
        }
      }
      return { leaks: leaks.sort((a, b) => b.sites.length - a.sites.length).slice(0, 30), total: leaks.length };
    },
  },

  check_net_factor: {
    def: {
      type: "function",
      function: {
        name: "check_net_factor",
        description: "Mostra qual NET_FACTOR está sendo aplicado (default 0.935 = 1 - 6.5% rev share) e recalcula net revenue + profit para uma campanha/placement.",
        parameters: { type: "object", properties: { gross_revenue_usd: { type: "number" }, cost_usd: { type: "number" }, net_factor: { type: "number" } }, required: ["gross_revenue_usd", "cost_usd"] },
      },
    },
    run: async (a) => {
      const nf = typeof a.net_factor === "number" ? a.net_factor : NET_FACTOR_DEFAULT;
      const net = a.gross_revenue_usd * nf;
      const profit = net - a.cost_usd;
      return {
        net_factor_used: nf, net_factor_default: NET_FACTOR_DEFAULT,
        gross_revenue_usd: a.gross_revenue_usd, net_revenue_usd: round(net),
        cost_usd: a.cost_usd, profit_usd: round(profit),
        roi_pct: a.cost_usd > 0 ? round((profit / a.cost_usd) * 100) : null,
        formula: "profit = (gross_revenue * net_factor) - cost ; roi_pct = profit/cost*100",
      };
    },
  },

  compare_with_gam: {
    def: {
      type: "function",
      function: {
        name: "compare_with_gam",
        description: "Compara revenue agregada por campanha entre gam_campaign_source_revenue (atribuída via UTM) e a soma de gam_placement_revenue do mesmo período. Discrepâncias indicam attribution incompleta ou duplicada.",
        parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, site_id: { type: "string" }, campaign_id: { type: "string" } }, required: ["from", "to"] },
      },
    },
    run: async (a, { userId, admin }) => {
      let srcQ = admin.from("gam_campaign_source_revenue").select("campaign_id, revenue_usd, impressions, utm_source").eq("user_id", userId).gte("date", a.from).lte("date", a.to);
      let plcQ = admin.from("gam_placement_revenue").select("campaign_id, revenue_usd, impressions").eq("user_id", userId).gte("date", a.from).lte("date", a.to);
      if (a.site_id) { srcQ = srcQ.eq("site_id", a.site_id); plcQ = plcQ.eq("site_id", a.site_id); }
      if (a.campaign_id) { srcQ = srcQ.eq("campaign_id", a.campaign_id); plcQ = plcQ.eq("campaign_id", a.campaign_id); }
      const [{ data: src }, { data: plc }] = await Promise.all([srcQ, plcQ]);
      const srcAgg = new Map<string, { rev: number; imp: number; utms: Set<string> }>();
      for (const r of src ?? []) {
        const cur = srcAgg.get(r.campaign_id) ?? { rev: 0, imp: 0, utms: new Set() };
        cur.rev += Number(r.revenue_usd) || 0; cur.imp += Number(r.impressions) || 0;
        if (r.utm_source) cur.utms.add(r.utm_source);
        srcAgg.set(r.campaign_id, cur);
      }
      const plcAgg = new Map<string, { rev: number; imp: number }>();
      for (const r of plc ?? []) {
        const cur = plcAgg.get(r.campaign_id) ?? { rev: 0, imp: 0 };
        cur.rev += Number(r.revenue_usd) || 0; cur.imp += Number(r.impressions) || 0;
        plcAgg.set(r.campaign_id, cur);
      }
      const ids = new Set([...srcAgg.keys(), ...plcAgg.keys()]);
      const rows = [...ids].map((cid) => {
        const s = srcAgg.get(cid); const p = plcAgg.get(cid);
        const srcRev = s?.rev ?? 0; const plcRev = p?.rev ?? 0;
        const diff = plcRev - srcRev;
        const pct = srcRev > 0 ? (diff / srcRev) * 100 : null;
        return {
          campaign_id: cid,
          source_revenue_usd: round(srcRev), placement_revenue_usd: round(plcRev),
          diff_usd: round(diff), diff_pct: pct === null ? null : round(pct),
          utm_sources: [...(s?.utms ?? [])],
          flag: Math.abs(pct ?? 0) > 5 ? "mismatch" : "ok",
        };
      }).sort((a, b) => Math.abs(b.diff_usd) - Math.abs(a.diff_usd));
      return { campaigns: rows.slice(0, 50) };
    },
  },

  explain_placement_roi: {
    def: {
      type: "function",
      function: {
        name: "explain_placement_roi",
        description: "Explica de onde vem o ROI de um placement específico: lista linhas por dia (cost, gross, net, profit) e calcula a fórmula passo a passo.",
        parameters: { type: "object", properties: { campaign_id: { type: "string" }, placement: { type: "string" }, from: { type: "string" }, to: { type: "string" }, net_factor: { type: "number" } }, required: ["campaign_id", "placement", "from", "to"] },
      },
    },
    run: async (a, { userId, admin }) => {
      const nf = typeof a.net_factor === "number" ? a.net_factor : NET_FACTOR_DEFAULT;
      const [{ data: ads }, { data: gam }] = await Promise.all([
        admin.from("ads_placements").select("date, cost, clicks, impressions").eq("user_id", userId).eq("campaign_id", a.campaign_id).eq("placement", a.placement).gte("date", a.from).lte("date", a.to).order("date"),
        admin.from("gam_placement_revenue").select("date, revenue_usd, impressions, site_id, source, utm_source, raw_utm").eq("user_id", userId).eq("campaign_id", a.campaign_id).eq("placement", a.placement).gte("date", a.from).lte("date", a.to).order("date"),
      ]);
      const byDate = new Map<string, any>();
      for (const r of ads ?? []) {
        const k = r.date; const cur = byDate.get(k) ?? { date: k, cost: 0, gross: 0, clicks: 0, ads_imp: 0, gam_imp: 0 };
        cur.cost += Number(r.cost) || 0; cur.clicks += Number(r.clicks) || 0; cur.ads_imp += Number(r.impressions) || 0; byDate.set(k, cur);
      }
      for (const r of gam ?? []) {
        const k = r.date; const cur = byDate.get(k) ?? { date: k, cost: 0, gross: 0, clicks: 0, ads_imp: 0, gam_imp: 0 };
        cur.gross += Number(r.revenue_usd) || 0; cur.gam_imp += Number(r.impressions) || 0; byDate.set(k, cur);
      }
      const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
        const net = d.gross * nf; const profit = net - d.cost;
        return { date: d.date, cost_usd: round(d.cost), gross_usd: round(d.gross), net_usd: round(net), profit_usd: round(profit), roi_pct: d.cost > 0 ? round((profit / d.cost) * 100) : null, ads_imp: d.ads_imp, gam_imp: d.gam_imp };
      });
      const totals = days.reduce((acc, d) => { acc.cost += d.cost_usd; acc.gross += d.gross_usd; acc.net += d.net_usd; acc.profit += d.profit_usd; return acc; }, { cost: 0, gross: 0, net: 0, profit: 0 });
      return {
        placement: a.placement, campaign_id: a.campaign_id, net_factor: nf,
        days, totals: { ...totals, roi_pct: totals.cost > 0 ? round((totals.profit / totals.cost) * 100) : null },
        samples: { gam_sources: [...new Set((gam ?? []).map((r: any) => r.source).filter(Boolean))], utm_sources: [...new Set((gam ?? []).map((r: any) => r.utm_source).filter(Boolean))], sites: [...new Set((gam ?? []).map((r: any) => r.site_id).filter(Boolean))] },
      };
    },
  },

  detect_suspicious_placements: {
    def: {
      type: "function",
      function: {
        name: "detect_suspicious_placements",
        description: "Top placements suspeitos: ROI > 2000%, ROI < -90%, revenue sem custo, ou impressões GAM >> impressões Ads (possível atribuição cruzada).",
        parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, site_id: { type: "string" }, campaign_id: { type: "string" }, min_cost_usd: { type: "number" } }, required: ["from", "to"] },
      },
    },
    run: async (a, { userId, admin }) => {
      const minCost = typeof a.min_cost_usd === "number" ? a.min_cost_usd : 1;
      const nf = NET_FACTOR_DEFAULT;
      let adsQ = admin.from("ads_placements").select("placement, campaign_id, campaign_name, cost, impressions").eq("user_id", userId).gte("date", a.from).lte("date", a.to);
      let gamQ = admin.from("gam_placement_revenue").select("placement, campaign_id, revenue_usd, impressions").eq("user_id", userId).gte("date", a.from).lte("date", a.to);
      if (a.campaign_id) { adsQ = adsQ.eq("campaign_id", a.campaign_id); gamQ = gamQ.eq("campaign_id", a.campaign_id); }
      if (a.site_id) gamQ = gamQ.eq("site_id", a.site_id);
      const [{ data: ads }, { data: gam }] = await Promise.all([adsQ, gamQ]);
      const m = new Map<string, any>();
      for (const r of ads ?? []) {
        const k = `${r.campaign_id}|${r.placement}`;
        const cur = m.get(k) ?? { campaign_id: r.campaign_id, campaign_name: r.campaign_name, placement: r.placement, cost: 0, gross: 0, ads_imp: 0, gam_imp: 0 };
        cur.cost += Number(r.cost) || 0; cur.ads_imp += Number(r.impressions) || 0; m.set(k, cur);
      }
      for (const r of gam ?? []) {
        const k = `${r.campaign_id}|${r.placement}`;
        const cur = m.get(k) ?? { campaign_id: r.campaign_id, campaign_name: null, placement: r.placement, cost: 0, gross: 0, ads_imp: 0, gam_imp: 0 };
        cur.gross += Number(r.revenue_usd) || 0; cur.gam_imp += Number(r.impressions) || 0; m.set(k, cur);
      }
      const suspects: any[] = [];
      for (const r of m.values()) {
        const net = r.gross * nf; const profit = net - r.cost;
        const roi = r.cost > 0 ? (profit / r.cost) * 100 : null;
        const reasons: string[] = [];
        if (roi !== null && roi > 2000) reasons.push("roi_too_high");
        if (roi !== null && roi < -90 && r.cost >= minCost) reasons.push("roi_too_low");
        if (r.cost === 0 && r.gross > 1) reasons.push("revenue_without_cost");
        if (r.ads_imp > 100 && r.gam_imp > r.ads_imp * 5) reasons.push("gam_impressions_inflated");
        if (reasons.length) suspects.push({ ...r, cost_usd: round(r.cost), gross_revenue_usd: round(r.gross), net_revenue_usd: round(net), profit_usd: round(profit), roi_pct: roi === null ? null : round(roi), reasons });
      }
      return { suspects: suspects.sort((a, b) => (b.gross_revenue_usd + b.cost_usd) - (a.gross_revenue_usd + a.cost_usd)).slice(0, 30) };
    },
  },
};

function round(n: number, d = 2) { return Math.round(n * 10 ** d) / 10 ** d; }

const SYSTEM_PROMPT = `Você é o AI Auditor do dashboard de arbitragem do usuário. Você investiga dados reais usando as tools disponíveis — nunca chuta números.

Domínio:
- O usuário faz arbitragem: roda Google Ads (custo) → tráfego cai no site → Google Ad Manager (GAM) gera receita via AdSense/AdX.
- Atribuição: campanha do Google Ads carrega \`utm_placement={campaignid}_{placement}\` no Final URL Suffix. O GAM grava receita por placement no row \`gam_placement_revenue\` (com site_id, campaign_id, placement).
- Receita líquida = gross_revenue_usd * NET_FACTOR (default ${NET_FACTOR_DEFAULT}, equivalente a 6.5% rev share da rede).
- ROI = (net_revenue - cost) / cost * 100.
- Tabelas: ads_placements (Google Ads), gam_placement_revenue (receita por placement), gam_campaign_source_revenue (receita agregada por utm_source/campaign), campaigns, sites.

Regras:
1. SEMPRE use as tools para responder qualquer pergunta sobre números, atribuição, ROI ou suspeitas. Nunca invente valores.
2. Use o contexto da aba (active_tab, site_id, range, selected_placement, selected_campaign) como filtros default das tools.
3. Em modo debug, mostre a fórmula, valores brutos, queries lógicas (não SQL literal), e os flags retornados pelas tools.
4. Respostas em pt-BR, técnicas, diretas. Use markdown. Listas/tabelas quando útil.
5. Se uma tool retornar flags (cost_without_revenue, multiple_sites, roi_impossible, mismatch, etc), DESTAQUE e explique o que significa e o provável bug.
6. Quando o usuário pedir "isso está calculando certo?" em um placement específico, rode validate_placement_revenue + explain_placement_roi e cruze com detect_cross_site_leak/compare_with_gam se necessário.`;

type ProviderRoute =
  | { kind: "lovable"; model: string }
  | { kind: "external"; provider: string; baseUrl: string; apiKey: string; model: string };

async function resolveProvider(admin: any, userId: string): Promise<ProviderRoute> {
  const { data: cfg } = await admin.from("ai_provider_configs").select("*")
    .eq("user_id", userId).eq("is_active", true).eq("enabled", true).maybeSingle();
  if (cfg && OPENAI_COMPATIBLE.has(cfg.provider) && cfg.api_key_encrypted && cfg.api_key_iv) {
    try {
      const apiKey = await decryptApiKey(cfg.api_key_encrypted, cfg.api_key_iv);
      return {
        kind: "external",
        provider: cfg.provider,
        baseUrl: (cfg.base_url || DEFAULT_BASE_URL[cfg.provider]).replace(/\/+$/, ""),
        apiKey,
        model: cfg.model || DEFAULT_MODEL[cfg.provider],
      };
    } catch (e) {
      console.error("[ai-assistant] failed to decrypt provider key, falling back", e);
    }
  }
  return { kind: "lovable", model: "google/gemini-2.5-flash" };
}

async function callModel(route: ProviderRoute, messages: any[], toolDefs: any[], stepBudget: number) {
  const url = route.kind === "lovable" ? AI_GATEWAY_URL : `${route.baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (route.kind === "lovable") {
    headers.Authorization = `Bearer ${LOVABLE_API_KEY}`;
    headers["X-Lovable-AIG-SDK"] = "edge-fn-raw";
  } else {
    headers.Authorization = `Bearer ${route.apiKey}`;
  }
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: route.model,
      messages,
      tools: toolDefs,
      tool_choice: stepBudget > 0 ? "auto" : "none",
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`${route.kind === "lovable" ? "lovable" : route.provider} ${r.status}: ${txt.slice(0, 500)}`);
  }
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const body = await req.json();
    const { thread_id, message, context } = body ?? {};
    if (!message || typeof message !== "string") return json({ error: "message required" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // resolve/cria thread
    let threadId = thread_id as string | undefined;
    if (!threadId) {
      const { data: t, error } = await admin.from("ai_threads").insert({
        user_id: user.id,
        title: message.slice(0, 60),
        active_tab: context?.active_tab ?? null,
        context: context ?? {},
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      threadId = t.id;
    } else {
      // valida ownership
      const { data: t } = await admin.from("ai_threads").select("id").eq("id", threadId).eq("user_id", user.id).maybeSingle();
      if (!t) return json({ error: "thread not found" }, 404);
      await admin.from("ai_threads").update({ context: context ?? {}, active_tab: context?.active_tab ?? null }).eq("id", threadId);
    }

    // grava mensagem do usuário
    await admin.from("ai_messages").insert({
      thread_id: threadId, user_id: user.id, role: "user", content: message,
      parts: context ? { context } : null,
    });

    // histórico
    const { data: history } = await admin.from("ai_messages")
      .select("role, content, parts").eq("thread_id", threadId).order("created_at").limit(40);

    const contextLine = context ? `\n\nCONTEXTO ATUAL DA ABA:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`` : "";
    const msgs: any[] = [
      { role: "system", content: SYSTEM_PROMPT + contextLine },
      ...(history ?? []).map((m: any) => {
        if (m.role === "tool" && m.parts?.tool_call_id) {
          return { role: "tool", tool_call_id: m.parts.tool_call_id, content: m.content ?? "" };
        }
        if (m.role === "assistant" && m.parts?.tool_calls) {
          return { role: "assistant", content: m.content ?? "", tool_calls: m.parts.tool_calls };
        }
        return { role: m.role, content: m.content ?? "" };
      }),
    ];

    const toolDefs = Object.values(tools).map((t) => t.def);
    const toolEvents: any[] = [];
    let final = "";
    let lastAssistant: any = null;

    for (let step = 0; step < 6; step += 1) {
      const resp = await callGateway(msgs, toolDefs, 6 - step);
      const choice = resp?.choices?.[0]?.message;
      if (!choice) throw new Error("no choice");
      lastAssistant = choice;
      const toolCalls = choice.tool_calls ?? [];
      if (!toolCalls.length) { final = choice.content ?? ""; break; }
      msgs.push({ role: "assistant", content: choice.content ?? "", tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* */ }
        const fn = tools[name];
        let result: any;
        try { result = fn ? await fn.run(args, { userId: user.id, admin }) : { error: `unknown tool ${name}` }; }
        catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
        toolEvents.push({ name, args, result });
        msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12000) });
      }
    }

    // persiste tool events como uma mensagem 'tool' (visão única) + assistant final
    if (toolEvents.length) {
      await admin.from("ai_messages").insert({
        thread_id: threadId, user_id: user.id, role: "tool", content: null,
        parts: { tool_events: toolEvents },
      });
    }
    await admin.from("ai_messages").insert({
      thread_id: threadId, user_id: user.id, role: "assistant",
      content: final, parts: lastAssistant?.tool_calls ? { tool_calls: lastAssistant.tool_calls } : null,
    });

    return json({ thread_id: threadId, content: final, tool_events: toolEvents });
  } catch (e) {
    console.error("[ai-assistant] error", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
