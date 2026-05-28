// Auto-onboard de um novo site:
// 1) Marca status=processing
// 2) Em background, dispara: google-ads-sync-campaigns + gam-sync-revenue (janela ampla — todo histórico vinculado ao gasto Ads)
// 3) Para cada campanha do site, dispara google-ads-sync-placements
// 4) Atualiza sites.sync_status=completed/failed
//
// Retorna 202 imediatamente para não travar a UI.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function callFn(name: string, body: unknown, authHeader: string) {
  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
          apikey: SERVICE_ROLE,
        },
        body: JSON.stringify(body ?? {}),
      });
      const text = await r.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
      const parsedObj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      const summaryHasError = Array.isArray(parsedObj?.summary)
        && parsedObj.summary.some((s) => s && typeof s === "object" && "error" in (s as Record<string, unknown>));
      const bodyHasError = !!parsedObj?.error || summaryHasError;
      if (r.status !== 429 || attempt === 2) return { ok: r.ok && !bodyHasError, status: r.status, body: parsed };
      await delay(15_000 * (attempt + 1));
    } catch (e) {
      const retryAfterMs = Number((e as { retryAfterMs?: number })?.retryAfterMs ?? 0);
      const msg = e instanceof Error ? e.message : String(e);
      const isRateLimit = msg.toLowerCase().includes("rate limit") || retryAfterMs > 0;
      if (!isRateLimit || attempt === 2) return { ok: false, status: 0, body: { error: msg } };
      await delay(Math.min(Math.max(retryAfterMs, 10_000), 45_000));
    }
  }
  return { ok: false, status: 0, body: { error: "unknown call failure" } };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBackground(siteId: string, userId: string, authHeader: string, incremental = false, requestedRange?: { from?: string; to?: string }) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const startedAt = Date.now();
  const deadlineAt = startedAt + 110_000;
  const hasBudget = (minimumMs = 20_000) => Date.now() + minimumMs < deadlineAt;
  const to = isoDaysAgo(0);
  const syncLog = {
    siteId,
    campaignRows: 0,
    placementsOk: 0,
    placementsTotal: 0,
    gamChunks: [] as Array<{ from: string; to: string; status: number; ok: boolean }>,
    errors: [] as string[],
  };

  try {
    // contas Ads vinculadas ao site
    const { data: links } = await admin
      .from("account_site_links")
      .select("google_account_id")
      .eq("user_id", userId)
      .eq("site_id", siteId);
    const accountIds = (links ?? []).map((l: { google_account_id: string }) => l.google_account_id);

    // Janela dinâmica: começa na primeira data em que houve receita GAM atribuída
    // (UTM source) a alguma campanha Ads deste site. Se não houver, faz primeiro
    // um sync de receita para descobrir, e depois recalcula. Limite máx 90 dias
    // (limite prático do Google Ads detail_placement_view).
    // Janela máx de 30 dias no primeiro onboard. Depois disso, refresh manual/cron
    // atualiza só a janela recente para não gastar todo o runtime reprocessando histórico
    // e deixar o dashboard/placements sem atualização.
    // Janela máx de 30 dias, mas só recua até onde as campanhas Ads do site
    // já estavam com UTM correto (ou seja, há receita GAM atribuída ao site_id).
    const cap = isoDaysAgo(incremental ? 7 : 30);

    async function detectFromDate(): Promise<string> {
      const { data: rev } = await admin
        .from("gam_placement_revenue")
        .select("date")
        .eq("user_id", userId)
        .eq("site_id", siteId)
        .gte("date", cap)
        .order("date", { ascending: true })
        .limit(1);
      const earliest = rev?.[0]?.date as string | undefined;
      // Se ainda não há receita atribuída salva, sincroniza os 30 dias em chunks pequenos.
      // O GAM só grava receita quando encontra UTM/campaign/placement válido, então não traz órfãos.
      if (!earliest) return cap;
      return earliest < cap ? cap : earliest;
    }

    const validDate = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const requestedFrom = validDate(requestedRange?.from) ? requestedRange!.from! : null;
    const requestedTo = validDate(requestedRange?.to) ? requestedRange!.to! : null;
    const from = requestedFrom ?? await detectFromDate();
    const effectiveTo = requestedTo ?? to;
    console.log("[auto-onboard] window", { siteId, from, to: effectiveTo });

    // 1. campanhas (Google Ads)
    const ads = await callFn(
      "google-ads-sync-campaigns",
      { from, to: effectiveTo, site_id: siteId, account_ids: accountIds, user_id: userId },
      authHeader,
    );
    console.log("[auto-onboard] ads sync", { siteId, status: ads.status });
    if (!ads.ok) syncLog.errors.push(`ads sync ${ads.status}: ${JSON.stringify(ads.body).slice(0, 300)}`);

    // 2. receita GAM em chunks pequenos e aguardando concluir.
    // Sem `sync:true`, a função retorna "started" imediatamente, os chunks rodam em paralelo
    // e o GAM devolve 429; a Retenção fica parecendo concluída sem atualizar.
    const chunkDays = incremental ? 3 : 7;
    const fromDate = new Date(from + "T00:00:00Z");
    const toDate = new Date(effectiveTo + "T00:00:00Z");
    const chunks: Array<{ from: string; to: string }> = [];
    for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + chunkDays)) {
      const cFrom = d.toISOString().slice(0, 10);
      const cEndDate = new Date(d);
      cEndDate.setUTCDate(cEndDate.getUTCDate() + chunkDays - 1);
      if (cEndDate > toDate) cEndDate.setTime(toDate.getTime());
      const cTo = cEndDate.toISOString().slice(0, 10);
      chunks.push({ from: cFrom, to: cTo });
    }
    // Chunks em série e do mais recente para o mais antigo: o dashboard atualiza primeiro
    // os últimos dias, mesmo se o runtime cortar o trabalho longo antes de completar 30 dias.
    const orderedChunks = chunks.reverse();
    for (let idx = 0; idx < orderedChunks.length; idx += 1) {
      const c = orderedChunks[idx];
      const isFreshestChunk = idx === 0;
      if (!hasBudget(isFreshestChunk ? 35_000 : 25_000)) {
        console.warn("[auto-onboard] stopping GAM chunks due deadline", { siteId, next: c });
        break;
      }
      // Viewability/eCPM diários são leves (só dim DATE) — rodar em TODOS os chunks
      // para que o dashboard mostre métricas corretas em todo o intervalo, não só nos últimos dias.
      const gam = await callFn(
        "gam-sync-revenue",
        { from: c.from, to: c.to, site_id: siteId, account_ids: accountIds, user_id: userId, revenue_only: true, sync: true, skip_viewability: false, skip_snapshot_regen: true },
        authHeader,
      );
      console.log("[auto-onboard] gam chunk", { siteId, from: c.from, to: c.to, status: gam.status });
      syncLog.gamChunks.push({ ...c, status: gam.status, ok: gam.ok });
      if (!gam.ok) syncLog.errors.push(`gam ${c.from}..${c.to} ${gam.status}: ${JSON.stringify(gam.body).slice(0, 300)}`);
      await delay(1_000);
    }

    // 3. placements por campanha do site
    const { data: campaigns } = await admin
      .from("campaigns")
      .select("campaign_id, google_account_id")
      .eq("user_id", userId)
      .in("google_account_id", accountIds.length ? accountIds : ["00000000-0000-0000-0000-000000000000"])
      .limit(50);
    syncLog.campaignRows = campaigns?.length ?? 0;

    let placementsOk = 0;
    const camps = campaigns ?? [];
    for (const c of camps) {
      if (!hasBudget(12_000)) {
        console.warn("[auto-onboard] stopping placements due deadline", { siteId });
        break;
      }
      const placement = await callFn("google-ads-sync-placements", { campaign_id: c.campaign_id, from, to: effectiveTo, user_id: userId }, authHeader);
      if (placement.ok) placementsOk += 1;
      else syncLog.errors.push(`placement ${c.campaign_id} ${placement.status}: ${JSON.stringify(placement.body).slice(0, 200)}`);
      await delay(1_000);
    }
    syncLog.placementsOk = placementsOk;
    syncLog.placementsTotal = campaigns?.length ?? 0;
    console.log("[auto-onboard] placements synced", { siteId, ok: placementsOk, total: campaigns?.length ?? 0 });
    console.log("[auto-onboard] sync log", syncLog);

    const hasErrors = syncLog.errors.length > 0;
    await admin
      .from("sites")
      .update({
        sync_status: hasErrors ? "failed" : "completed",
        sync_error: hasErrors ? syncLog.errors.join("\n").slice(0, 1500) : null,
        last_full_sync_at: hasErrors ? undefined : new Date().toISOString(),
      })
      .eq("id", siteId)
      .eq("user_id", userId);
  } catch (e) {
    console.error("[auto-onboard] failed", e);
    await admin
      .from("sites")
      .update({
        sync_status: "failed",
        sync_error: e instanceof Error ? e.message : String(e),
      })
      .eq("id", siteId)
      .eq("user_id", userId);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const body = await req.json().catch(() => ({}));
    const { site_id, force } = body as { site_id?: string; force?: boolean };
    if (!site_id || typeof site_id !== "string") {
      return new Response(JSON.stringify({ error: "site_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Bypass de auth para chamadas via service role (cron). Pega user_id do dono do site.
    const isServiceRole = authHeader.includes(SERVICE_ROLE);
    const adminPre = createClient(SUPABASE_URL, SERVICE_ROLE);
    let ownerUserId: string | null = null;
    let callerUserId: string | null = null;
    if (isServiceRole) {
      const { data: siteRow } = await adminPre.from("sites").select("user_id").eq("id", site_id).maybeSingle();
      if (siteRow?.user_id) {
        ownerUserId = siteRow.user_id;
        callerUserId = siteRow.user_id;
      }
    } else {
      const supa = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: u } } = await supa.auth.getUser();
      if (u) {
        callerUserId = u.id;
        const { data: siteRow } = await adminPre.from("sites").select("user_id").eq("id", site_id).maybeSingle();
        if (siteRow?.user_id) {
          if (siteRow.user_id === u.id) {
            ownerUserId = u.id;
          } else {
            // Caller pode ser admin (super_admin ou admin_site_access). Usa o user_id do dono pro sync.
            const { data: canAccess } = await adminPre.rpc("can_access_site", { _uid: u.id, _site_id: site_id });
            if (canAccess) ownerUserId = siteRow.user_id;
          }
        }
      }
    }
    if (!callerUserId || !ownerUserId) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: site } = await admin
      .from("sites")
      .select("id, sync_status, sync_started_at, last_full_sync_at")
      .eq("id", site_id)
      .eq("user_id", ownerUserId)
      .maybeSingle();
    if (!site) {
      return new Response(JSON.stringify({ error: "site not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Se já está rodando há menos de 5 min, devolve idempotente
    const startedAt = site.sync_started_at ? new Date(site.sync_started_at).getTime() : 0;
    const ageMin = (Date.now() - startedAt) / 60000;
    if (!force && site.sync_status === "processing" && ageMin < 5) {
      return new Response(JSON.stringify({ status: "processing", message: "already running" }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!force && site.sync_status === "completed" && site.last_full_sync_at) {
      return new Response(JSON.stringify({ status: "completed", message: "already onboarded" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isIncrementalRefresh = !!site.last_full_sync_at;

    await admin
      .from("sites")
      .update({ sync_status: "processing", sync_started_at: new Date().toISOString(), sync_error: null })
      .eq("id", site_id)
      .eq("user_id", ownerUserId);

    // Roda sync com user_id do dono (que tem os tokens Google Ads e vínculos).
    // Usa SERVICE_ROLE no Authorization pras chamadas internas — caller (ex: Cesar admin) pode não ter acesso direto.
    const internalAuth = `Bearer ${SERVICE_ROLE}`;
    // @ts-ignore EdgeRuntime is available in Supabase edge functions
    EdgeRuntime.waitUntil(runBackground(site_id, ownerUserId, internalAuth, isIncrementalRefresh));

    return new Response(JSON.stringify({ status: "processing", site_id }), {
      status: 202,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
