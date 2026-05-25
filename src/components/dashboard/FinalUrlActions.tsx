import { ExternalLink, Copy, Check, AlertCircle, RefreshCw, Target } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

export interface FinalUrlInfo {
  url?: string | null;
  source?: string | null; // ad.final_urls | campaign.final_urls | inferred | fallback | unknown
  trackingTemplate?: string | null;
  finalUrlSuffix?: string | null;
  mobileUrl?: string | null;
}

interface Props extends FinalUrlInfo {
  className?: string;
  compact?: boolean;
  campaignId?: string;
  googleAccountId?: string | null;
  onRefresh?: () => Promise<void> | void;
}

const CANONICAL_SUFFIX =
  "utm_source=google&utm_campaign={campaignid}&utm_adgroup={adgroupid}&utm_content={creative}&utm_placement={campaignid}_{placement}";

function parseUrl(raw: string) {
  try {
    const u = new URL(raw);
    return { host: u.host, path: u.pathname + u.search, ok: true };
  } catch {
    return { host: raw, path: "", ok: false };
  }
}

const SOURCE_LABELS: Record<string, { label: string; cls: string }> = {
  "ad.final_urls": { label: "ad.final_urls", cls: "bg-success/15 text-success border-success/30" },
  "campaign.final_urls": { label: "campaign.final_urls", cls: "bg-primary/15 text-primary border-primary/30" },
  inferred: { label: "inferred", cls: "bg-warning/15 text-warning border-warning/30" },
  fallback: { label: "fallback", cls: "bg-warning/15 text-warning border-warning/30" },
  unknown: { label: "UNKNOWN", cls: "bg-destructive/15 text-destructive border-destructive/30" },
};

export function FinalUrlActions({
  url, source, trackingTemplate, finalUrlSuffix, mobileUrl,
  className, compact, campaignId, googleAccountId, onRefresh,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [syncing, setSyncing] = useState<"url" | "utm" | null>(null);

  const sourceMeta = SOURCE_LABELS[String(source ?? "unknown")] ?? SOURCE_LABELS.unknown;
  const suffixOk = (finalUrlSuffix ?? "").trim() === CANONICAL_SUFFIX;

  const handleSyncUrl = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSyncing("url");
    try {
      const { data, error } = await supabase.functions.invoke("google-ads-sync-final-urls", {
        body: googleAccountId ? { account_ids: [googleAccountId] } : {},
      });
      if (error || (data as any)?.error) {
        toast({ title: "Erro ao sincronizar URL", description: error?.message ?? (data as any)?.error, variant: "destructive" });
      } else {
        toast({ title: "URLs sincronizadas", description: `${(data as any)?.upserted ?? 0} linha(s) atualizadas.` });
        await onRefresh?.();
      }
    } finally {
      setSyncing(null);
    }
  };

  const handleApplyUtm = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!campaignId) return;
    setSyncing("utm");
    try {
      const { data, error } = await supabase.functions.invoke("google-ads-apply-utm-bulk", {
        body: { campaign_ids: [campaignId] },
      });
      if (error || (data as any)?.error) {
        toast({ title: "Erro ao aplicar UTM", description: error?.message ?? (data as any)?.error, variant: "destructive" });
      } else {
        toast({ title: "UTM canônico aplicado", description: `${(data as any)?.success ?? 0}/${(data as any)?.total ?? 0} campanha(s).` });
        // Re-sync URLs to pick up the new suffix from the API
        await supabase.functions.invoke("google-ads-sync-final-urls", {
          body: googleAccountId ? { account_ids: [googleAccountId] } : {},
        });
        await onRefresh?.();
      }
    } finally {
      setSyncing(null);
    }
  };

  if (!url) {
    return (
      <TooltipProvider delayDuration={150}>
        <div className={cn("inline-flex items-center gap-1.5", className)}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 text-[11px] text-destructive/80">
                <AlertCircle className="h-3 w-3" /> UNKNOWN URL
                <Badge variant="outline" className={cn("h-4 px-1 text-[9px]", sourceMeta.cls)}>{sourceMeta.label}</Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[420px] text-xs">
              <div className="font-semibold">Sem URL confiável da API do Google Ads.</div>
              {trackingTemplate && <div className="mt-1">tracking_template: <span className="font-mono break-all">{trackingTemplate}</span></div>}
              {finalUrlSuffix && <div>final_url_suffix: <span className="font-mono break-all">{finalUrlSuffix}</span></div>}
              {!trackingTemplate && !finalUrlSuffix && <div className="text-muted-foreground">Clique em "Sincronizar URL" para puxar da API.</div>}
            </TooltipContent>
          </Tooltip>
          <Button
            size="sm"
            variant="outline"
            className="h-5 px-1.5 text-[10px] gap-1"
            disabled={syncing !== null}
            onClick={handleSyncUrl}
            title="Sincronizar URL do Google Ads"
          >
            <RefreshCw className={cn("h-2.5 w-2.5", syncing === "url" && "animate-spin")} />
            Sincronizar URL
          </Button>
          {campaignId && (
            <Button
              size="sm"
              variant="outline"
              className="h-5 px-1.5 text-[10px] gap-1"
              disabled={syncing !== null}
              onClick={handleApplyUtm}
              title="Aplicar UTM canônico nesta campanha"
            >
              <Target className={cn("h-2.5 w-2.5", syncing === "utm" && "animate-spin")} />
              Aplicar UTM
            </Button>
          )}
        </div>
      </TooltipProvider>
    );
  }

  const { host, path } = parseUrl(url);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast({ title: "Link copiado", description: url });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Falha ao copiar", variant: "destructive" });
    }
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn("inline-flex items-center gap-1 max-w-full", className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "truncate text-xs text-primary hover:underline tabular-nums",
                compact ? "max-w-[260px]" : "max-w-[380px]",
              )}
            >
              <span className="text-muted-foreground">{host}</span>
              <span>{path}</span>
            </a>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[460px] text-xs space-y-1">
            <div className="font-mono break-all">{url}</div>
            {mobileUrl && mobileUrl !== url && <div>mobile: <span className="font-mono break-all">{mobileUrl}</span></div>}
            {trackingTemplate && <div>tracking_template: <span className="font-mono break-all">{trackingTemplate}</span></div>}
            {finalUrlSuffix && <div>final_url_suffix: <span className="font-mono break-all">{finalUrlSuffix}</span></div>}
            <div className="flex items-center gap-1 pt-1">
              <span className="text-muted-foreground">URL source:</span>
              <Badge variant="outline" className={cn("h-4 px-1 text-[9px]", sourceMeta.cls)}>{sourceMeta.label}</Badge>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">UTM canônico:</span>
              {suffixOk
                ? <Badge variant="outline" className="h-4 px-1 text-[9px] bg-success/15 text-success border-success/30">OK</Badge>
                : <Badge variant="outline" className="h-4 px-1 text-[9px] bg-destructive/15 text-destructive border-destructive/30">FALTA</Badge>}
            </div>
          </TooltipContent>
        </Tooltip>
        <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" title="Abrir página" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
        <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" title="Copiar link" onClick={handleCopy}>
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        </Button>
        <Badge variant="outline" className={cn("h-4 px-1 text-[9px] shrink-0", sourceMeta.cls)}>{sourceMeta.label}</Badge>
        {!suffixOk && campaignId && (
          <Button
            size="sm"
            variant="outline"
            className="h-5 px-1.5 text-[10px] gap-1 shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
            disabled={syncing !== null}
            onClick={handleApplyUtm}
            title="Final URL Suffix não é o canônico. Clique para aplicar."
          >
            <Target className={cn("h-2.5 w-2.5", syncing === "utm" && "animate-spin")} />
            UTM
          </Button>
        )}
      </div>
    </TooltipProvider>
  );
}
