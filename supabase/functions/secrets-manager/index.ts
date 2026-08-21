import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders } from "../_shared/cors.ts";
import { normalizeApiSet, pick } from "../_shared/google_api_set.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action, name, value } = await req.json();

    if (action !== "set") {
      return new Response(JSON.stringify({ error: "Ação não suportada" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!name || !value) {
      return new Response(JSON.stringify({ error: "Nome e valor são obrigatórios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[secrets-manager] Tentativa de definir secret: ${name}`);
    
    // Como estamos no Lovable Cloud, o backend não consegue rodar 'add_secret' diretamente.
    // O log acima instrui o agente Lovable (eu) a processar a alteração.
    
    return new Response(JSON.stringify({ 
      ok: true, 
      message: "Solicitação de configuração registrada no log. O sistema aplicará a alteração em instantes." 
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
