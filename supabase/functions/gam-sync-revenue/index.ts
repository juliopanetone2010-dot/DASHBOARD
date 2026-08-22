// Sincroniza receita do Google Ad Manager (REST API v1 beta + SOAP ReportService para Intraday)
// REBUILD ATTEMPT 1.0.5 - CLEAN SLATE
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return new Response(JSON.stringify({ ok: true, msg: "Clean slate v1.0.5" }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
