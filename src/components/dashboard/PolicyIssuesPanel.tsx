import { useState } from "react";
import { AlertTriangle, ExternalLink, Loader2, ShieldAlert, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface PolicyImage {
  asset: string | null;
  asset_id: string | null;
  field: string | null;
  kind: string;
  name: string;
  url: string;
}

interface PolicyAd {
  google_account_id: string;
  account: string;
  customer_id: string;
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  channel: string;
  ad_group_id: string;
  ad_id: string;
  ad_type: string;
  ad_status: string;
  approval: string;
  topics: Array<{ topic: string; type: string }>;
  images: PolicyImage[];
}

const TOPIC_PT: Record<string, string> = {
  MISLEADING_AD_DESIGN: "Design enganoso",
  CLICKBAIT: "Clickbait",
  UNRELIABLE_CLAIMS: "Afirmações não confiáveis",
  MISREPRESENTATION: "Deturpação",
  DESTINATION_NOT_WORKING: "Destino não funciona",
  DESTINATION_MISMATCH: "Destino incompatível",
  TRADEMARKS_IN_AD_TEXT: "Marca registrada",
  SEXUALLY_SUGGESTIVE: "Conteúdo sexual",
  SHOCKING_CONTENT: "Conteúdo chocante",
  UNAVAILABLE_OFFERS: "Oferta indisponível",
  IMAGE_QUALITY: "Qualidade da imagem",
  NON_FAMILY_SAFE: "Não adequado para família",
};

const CHANNEL_PT: Record<string, string> = { DISPLAY: "Display", DEMAND_GEN: "Demand Gen" };

/** Link pra tela do anúncio no Google Ads — lá aparece qual recurso foi reprovado. */
const adsLink = (a: PolicyAd) =>
  `https://ads.google.com/aw/ads?campaignId=${a.campaign_id}&adGroupId=${a.ad_group_id}&__e=${a.customer_id.replace(/\D/g, "")}`;

interface Props { siteId: string; }

export function PolicyIssuesPanel({ siteId }: Props) {
  const [loading, setLoading] = useState(false);
  const [includePaused, setIncludePaused] = useState(false);
  const [ads, setAds] = useState<PolicyAd[] | null>(null);
  const [errors, setErrors] = useState<Array<{ account: string; error: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke<{
        ok?: boolean; error?: string; ads?: PolicyAd[]; errors?: Array<{ account: string; error: string }>;
      }>("google-ads-policy-issues", { body: { site_id: siteId === "all" ? undefined : siteId, include_paused: includePaused } });
      if (error || data?.error) {
        toast({ title: "Erro ao buscar reprovados", description: data?.error ?? error?.message, variant: "destructive" });
        return;
      }
      setAds(data?.ads ?? []);
      setErrors(data?.errors ?? []);
    } finally { setLoading(false); }
  };

  // Mesma lógica do CampaignsTable: conta sem a declaração de publicidade
  // política da UE bloqueia toda alteração — declara e repete uma vez.
  const mutate = async (body: Record<string, unknown>, retried = false): Promise<string | null> => {
    const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>("google-ads-mutate", { body });
    const err = data?.error ?? error?.message ?? null;
    if (!retried && err && /political advertising declaration/i.test(err)) {
      const { data: fix, error: fixErr } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
        "google-ads-mutate", { body: { action: "declare_not_eu_political", campaign_id: body.campaign_id } },
      );
      if (!fixErr && !fix?.error) return mutate(body, true);
      return `Bloqueio de declaração política (UE): ${fix?.error ?? fixErr?.message}`;
    }
    return err;
  };

  const removeImage = async (a: PolicyAd, img: PolicyImage) => {
    if (!img.asset_id) return;
    if (!window.confirm(`Tirar a imagem "${img.name || img.asset_id}" do anúncio ${a.ad_id}?\n\nO anúncio e a campanha continuam rodando com as outras imagens.`)) return;
    const key = `${a.ad_id}|${img.asset_id}`;
    setBusy(key);
    try {
      const err = await mutate({ action: "remove_ad_image", campaign_id: a.campaign_id, ad_id: a.ad_id, asset_id: img.asset_id });
      if (err) { toast({ title: "Erro ao tirar imagem", description: err, variant: "destructive" }); return; }
      toast({ title: "Imagem tirada do anúncio", description: "O Google revisa o anúncio de novo — o aviso some depois da revisão." });
      setAds((list) => (list ?? []).map((x) => x.ad_id === a.ad_id && x.ad_group_id === a.ad_group_id
        ? { ...x, images: x.images.filter((i) => i.asset_id !== img.asset_id) } : x));
    } finally { setBusy(null); }
  };

  const removeAd = async (a: PolicyAd) => {
    if (!window.confirm(`Remover o anúncio ${a.ad_id} (reprovado) da campanha "${a.campaign_name}"?\n\nAnúncio removido não volta.`)) return;
    const key = `ad|${a.ad_id}`;
    setBusy(key);
    try {
      const err = await mutate({ action: "remove_disapproved_ad", campaign_id: a.campaign_id, ad_group_id: a.ad_group_id, ad_id: a.ad_id });
      if (err) { toast({ title: "Erro ao remover anúncio", description: err, variant: "destructive" }); return; }
      toast({ title: "Anúncio reprovado removido" });
      setAds((list) => (list ?? []).filter((x) => !(x.ad_id === a.ad_id && x.ad_group_id === a.ad_group_id)));
    } finally { setBusy(null); }
  };

  const disapproved = (ads ?? []).filter((a) => a.approval === "DISAPPROVED").length;
  const limited = (ads ?? []).length - disapproved;

  return (
    <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-danger" />
        <div className="text-sm font-semibold">Reprovados por política (Demand Gen e Display)</div>
        {ads && (
          <>
            <Badge variant="destructive">{disapproved} reprovado(s)</Badge>
            <Badge variant="secondary">{limited} limitado(s)</Badge>
          </>
        )}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id="policy-paused" checked={includePaused} onCheckedChange={setIncludePaused} />
            <Label htmlFor="policy-paused" className="text-xs">Incluir campanhas pausadas</Label>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            Verificar agora
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        O Google não informa pela API qual imagem de um anúncio com vários recursos foi reprovada. Abra
        "Ver no Google Ads" → clique no anúncio → "Detalhes do recurso" pra ver qual é, e use o ✕ na imagem
        pra tirar só ela. Anúncio totalmente reprovado pode ser removido direto.
      </p>

      {errors.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          Sem leitura em {errors.length} conta(s): {errors.map((e) => `${e.account} (${e.error.slice(0, 80)})`).join(" · ")}
        </div>
      )}

      {ads && ads.length === 0 && (
        <div className="text-sm text-success">Nenhum anúncio reprovado ou limitado {includePaused ? "" : "nas campanhas ativas"}.</div>
      )}

      {ads && ads.length > 0 && (
        <div className="space-y-2">
          {ads.map((a) => (
            <div key={`${a.customer_id}|${a.ad_group_id}|${a.ad_id}`} className="rounded-lg border bg-background p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={a.approval === "DISAPPROVED" ? "destructive" : "secondary"}>
                  {a.approval === "DISAPPROVED" ? "Reprovado" : "Limitado"}
                </Badge>
                <span className="font-medium">{a.campaign_name}</span>
                <span className="text-xs text-muted-foreground">
                  {a.account} · {CHANNEL_PT[a.channel] ?? a.channel} · campanha {a.campaign_status === "ENABLED" ? "ativa" : "pausada"} · anúncio {a.ad_id}
                </span>
                <span className="text-xs text-danger">
                  {a.topics.map((t) => TOPIC_PT[t.topic] ?? t.topic).join(", ")}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <a href={adsLink(a)} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    Ver no Google Ads <ExternalLink className="h-3 w-3" />
                  </a>
                  {a.approval === "DISAPPROVED" && (
                    <Button size="sm" variant="destructive" className="h-7 gap-1" disabled={busy !== null} onClick={() => removeAd(a)}>
                      {busy === `ad|${a.ad_id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      Remover anúncio
                    </Button>
                  )}
                </div>
              </div>
              {a.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {a.images.map((img, i) => {
                    const key = `${a.ad_id}|${img.asset_id}`;
                    return (
                      <div key={`${img.asset_id ?? "single"}-${img.field ?? ""}-${i}`}
                        className="relative w-24 rounded border bg-white overflow-hidden" title={`${img.kind} · ${img.name}`}>
                        {img.url
                          ? <img src={img.url} alt={img.name} className="h-20 w-full object-contain" loading="lazy" />
                          : <div className="h-20 grid place-items-center text-[10px] text-muted-foreground">sem prévia</div>}
                        <div className="px-1 py-0.5 text-[10px] text-muted-foreground truncate">{img.kind}</div>
                        {img.asset_id && img.field && (
                          <button
                            type="button"
                            aria-label="Tirar imagem do anúncio"
                            disabled={busy !== null}
                            onClick={() => removeImage(a, img)}
                            className={cn("absolute top-1 right-1 rounded-full bg-danger text-white p-0.5 shadow",
                              busy !== null && "opacity-50")}
                          >
                            {busy === key ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
