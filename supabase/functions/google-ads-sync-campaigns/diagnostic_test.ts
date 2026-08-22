
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"
import { getCreds, getAccessTokenFor } from "../_shared/google_api_set.ts"


const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function diagnostic(apiSet: number, targetMcc: string, targetCustomerId: string) {
    console.log(`\n--- DIAGNÓSTICO SET ${apiSet} (MCC ${targetMcc}) ---`)
    
    // 1. Get Credentials
    let creds;
    try {
        creds = getCreds(apiSet)
        console.log(`Developer Token (Set ${apiSet}): ${creds.devToken.substring(0, 5)}...`)
        console.log(`Client ID (Set ${apiSet}): ...${creds.clientId.slice(-8)}`)
    } catch (e) {
        console.error(`Erro ao obter credenciais Set ${apiSet}:`, e.message)
        return
    }

    // 2. Get Refresh Token from DB
    const { data: account, error: accError } = await supabase
        .from('google_accounts')
        .select('*')
        .eq('api_set', apiSet)
        .eq('customer_id', targetMcc.replace(/-/g, ''))
        .single()

    if (accError || !account) {
        console.error(`MCC ${targetMcc} não encontrada no banco para o Set ${apiSet}.`)
        // Listar o que temos no banco para esse set
        const { data: others } = await supabase.from('google_accounts').select('customer_id, api_set').eq('api_set', apiSet)
        console.log(`Contas no banco para Set ${apiSet}:`, others?.map(o => o.customer_id))
        return
    }

    const refreshToken = account.refresh_token
    console.log(`Refresh Token encontrado: ${refreshToken ? 'SIM' : 'NÃO'}`)

    // 3. Test OAuth / Access Token
    let accessToken;
    try {
        accessToken = await getAccessTokenFor(refreshToken, apiSet)
        console.log(`OAuth/Refresh Token válido? SIM`)
    } catch (e) {
        console.error(`OAuth/Refresh Token válido? NÃO`)
        console.error(`Erro bruto OAuth:`, e.message)
        return
    }

    // 4. List Sub-accounts (Customer IDs)
    console.log(`login_customer_id enviado: ${targetMcc.replace(/-/g, '')}`)
    const query = `SELECT customer_client.client_customer, customer_client.descriptive_name FROM customer_client WHERE customer_client.level <= 1`
    
    const listHeaders = {
        'developer-token': creds.devToken,
        'login-customer-id': targetMcc.replace(/-/g, ''),
        'Authorization': `Bearer ${accessToken}`
    }

    try {
        const listResp = await fetch(`https://googleads.googleapis.com/v24/customers/${targetMcc.replace(/-/g, '')}/googleAds:search`, {
            method: 'POST',
            headers: listHeaders,
            body: JSON.stringify({ query })
        })
        const listData = await listResp.json()
        
        if (!listResp.ok) {
            console.error(`Erro ao listar subcontas:`, JSON.stringify(listData))
        } else {
            console.log(`Customer IDs encontrados na MCC:`, listData.results?.length || 0)
            // console.log(listData.results?.map(r => r.customerClient.clientCustomer))
        }
    } catch (e) {
        console.error(`Erro gRPC/HTTP listar subcontas:`, e.message)
    }

    // 5. Query Metrics for Today (2026-08-21)
    const today = '2026-08-21'
    const metricsQuery = `
        SELECT 
            campaign.id, 
            campaign.name, 
            metrics.cost_micros 
        FROM campaign 
        WHERE segments.date = '${today}' 
          AND metrics.cost_micros > 0
    `
    
    console.log(`Consultando Customer ID: ${targetCustomerId.replace(/-/g, '')}`)
    try {
        const metricsResp = await fetch(`https://googleads.googleapis.com/v24/customers/${targetCustomerId.replace(/-/g, '')}/googleAds:search`, {
            method: 'POST',
            headers: listHeaders,
            body: JSON.stringify({ query: metricsQuery })
        })
        const metricsData = await metricsResp.json()

        if (!metricsResp.ok) {
            console.error(`Erro bruto Google Ads API:`, JSON.stringify(metricsData))
            console.log(`API respondeu? NÃO`)
        } else {
            console.log(`API respondeu? SIM`)
            const campaigns = metricsData.results || []
            console.log(`Quantidade de campanhas retornadas: ${campaigns.length}`)
            const totalCost = campaigns.reduce((acc: number, curr: any) => acc + parseInt(curr.metrics.costMicros), 0)
            console.log(`metrics.cost_micros retornado: ${totalCost}`)
            if (campaigns.length > 0) {
                console.log(`Exemplo Campanha: ${campaigns[0].campaign.name} | Gasto: ${campaigns[0].metrics.costMicros}`)
            }
        }
    } catch (e) {
        console.error(`Erro gRPC/HTTP consulta métricas:`, e.message)
    }
}

// Universo dos Cartões: Set 1 / MCC 434-538-1395 / Conta Exemplo (precisamos de um customer_id de conta filha que sabidamente gastou)
// Jardim Astral: Set 2 / MCC 719-750-3782 / Conta Exemplo

// Nota: O usuário citou a MCC 434-538-1395 (Universo) e 719-750-3782 (Jardim). 
// Para o teste de métricas, precisamos de uma conta filha. 
// Vou tentar buscar a primeira conta filha ativa no banco para cada MCC.

async function run() {
    // Diagnóstico Universo
    await diagnostic(1, '434-538-1395', '434-538-1395') // Se a MCC for a própria conta de gasto ou se usarmos ela pra listar
    
    // Diagnóstico Jardim
    await diagnostic(2, '719-750-3782', '719-750-3782')
}

run()
