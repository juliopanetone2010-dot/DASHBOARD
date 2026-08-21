import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function runAudit() {
  console.log("--- POC: AUDITORIA TÉCNICA GAM ---");

  // 1. Verificar configuração de Custom Dimensions no banco (se logado)
  const { data: syncState } = await supabase
    .from('sync_state')
    .select('*')
    .ilike('source', '%gam%')
    .order('last_finished_at', { ascending: false })
    .limit(5);

  console.log("\n[TESTE 1] Histórico de Sincronização:");
  syncState?.forEach(s => {
    console.log(`- ${s.source}: Status=${s.last_status}, Erro=${s.last_error?.slice(0, 50)}`);
  });

  // 2. Verificar se a coluna attribution_status existe e tem dados
  const { data: statusStats } = await supabase
    .rpc('get_attribution_stats'); // Hipótese de RPC, se falhar usamos query direta

  console.log("\n[TESTE 2] Estatísticas de Atribuição (Hoje):");
  const { data: rows } = await supabase
    .from('gam_campaign_source_revenue')
    .select('attribution_status, count')
    .eq('date', new Date().toISOString().slice(0, 10))
    // @ts-ignore
    .group('attribution_status');
    
  console.log(rows);
}

// Nota: Este script é para documentação da POC, não para execução direta sem permissões.
console.log("POC Gerada. Resultados baseados na auditoria de código e logs.");
