
import os
import json
import asyncio
from datetime import datetime
from supabase import create_client, Client

async def audit_sync():
    url = os.environ.get("VITE_SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("Missing Supabase credentials")
        return

    supabase: Client = create_client(url, key)
    
    # Parametros para a conta Ligados (715...) / 22953977775
    user_id = "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9"
    network_code = "22953977775"
    today = "2026-08-21"

    print(f"--- AUDIT START: {datetime.utcnow().isoformat()} UTC ---")
    
    # 1. Trigger sync e capturar logs do SOAP
    # Já fizemos o trigger na resposta anterior, vamos olhar os logs mais recentes que contenham dados de hoje
    
    # 3. Verificando o Banco de Dados
    print("\n3. Verificando gam_campaign_source_revenue para hoje:")
    res = supabase.table("gam_campaign_source_revenue") \
        .select("date, site_id, campaign_id, revenue_usd, utm_source, attribution_status, updated_at") \
        .eq("user_id", user_id) \
        .eq("date", today) \
        .order("revenue_usd", desc=True) \
        .limit(20) \
        .execute()
    
    if not res.data:
        print(f"RECEITA INTRADAY HOJE ({today}) = 0 REGISTROS NO BANCO")
    else:
        print(f"Encontrados {len(res.data)} registros para hoje.")
        for row in res.data:
            print(f"{row['date']} | {row['site_id']} | {row['campaign_id']} | ${row['revenue_usd']:.4f} | {row['utm_source']} | {row['attribution_status']} | {row['updated_at']}")

    # 4. Verificando Site Metrics (para ver se a receita total chegou)
    print("\n4. Verificando site_metrics_daily para hoje:")
    site_res = supabase.table("site_metrics_daily") \
        .select("site_id, revenue_native, impressions, updated_at") \
        .eq("user_id", user_id) \
        .eq("date", today) \
        .execute()
    
    for row in site_res.data:
        print(f"Site: {row['site_id']} | Rev: R$ {row['revenue_native']:.2f} | Impr: {row['impressions']} | Updated: {row['updated_at']}")

    print(f"\n--- AUDIT END ---")

if __name__ == "__main__":
    asyncio.run(audit_sync())
