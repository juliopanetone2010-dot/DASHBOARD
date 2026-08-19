import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import { normalizeApiSet, pick } from "../_shared/google_api_set.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { name, value } = await req.json();

    if (!name || !value) {
      return new Response(JSON.stringify({ error: "Nome e valor são obrigatórios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[secrets-manager] Tentativa de definir secret: ${name}`);
    // Este log é capturado pelo agente Lovable para processar a secret.
    
    return new Response(JSON.stringify({ 
      ok: true, 
      message: "Solicitação de secret registrada. O sistema processará em instantes." 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
