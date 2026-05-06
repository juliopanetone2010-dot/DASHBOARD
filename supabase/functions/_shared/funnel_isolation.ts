// Helper: campanhas que estão no Funil Inteligente NÃO devem ser tocadas
// pela automação principal, geo-cleanup, geo-expansion ou stop-loss.
// Considera bloqueadas as com funnel_status diferente de "graduated" e "failed-learning".
export async function getFunnelLockedCampaigns(admin: any, userId?: string): Promise<Set<string>> {
  let q = admin.from("campaign_funnel")
    .select("campaign_id, funnel_status")
    .not("funnel_status", "in", "(graduated,failed-learning)");
  if (userId) q = q.eq("user_id", userId);
  const { data } = await q;
  return new Set((data ?? []).map((r: any) => String(r.campaign_id)));
}
