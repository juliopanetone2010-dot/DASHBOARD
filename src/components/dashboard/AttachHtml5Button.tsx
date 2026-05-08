import { useState } from "react";
import { Upload, FileArchive, Check, Loader2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface Props {
  campaignId: string;
  campaignName?: string;
  googleAccountId?: string | null;
}

export function AttachHtml5Button({ campaignId, campaignName, googleAccountId }: Props) {
  const [open, setOpen] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const qc = useQueryClient();

  const adsQ = useQuery({
    enabled: open,
    queryKey: ["html5-ads-of-campaign", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("creative_metrics")
        .select("ad_id, ad_name, ad_type")
        .eq("campaign_id", campaignId)
        .order("ad_name", { ascending: true });
      if (error) throw error;
      const byAd = new Map<string, { ad_id: string; ad_name: string | null; ad_type: string | null }>();
      (data ?? []).forEach((r) => { if (!byAd.has(r.ad_id)) byAd.set(r.ad_id, r); });
      return Array.from(byAd.values()).filter((a) =>
        !a.ad_type || /display.*upload|html5|media.*bundle/i.test(a.ad_type)
      );
    },
  });

  const libQ = useQuery({
    enabled: open,
    queryKey: ["html5-library", campaignId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("html5_bundle_library")
        .select("id, source_ad_id, source_ad_name, zip_filename, created_at")
        .eq("source_campaign_id", campaignId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const savedByAd = new Map<string, any>();
  (libQ.data ?? []).forEach((r) => { if (r.source_ad_id) savedByAd.set(r.source_ad_id, r); });

  const upload = async (ad: { ad_id: string; ad_name: string | null }, file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast({ title: "Envie um .zip", variant: "destructive" }); return;
    }
    setUploadingId(ad.ad_id);
    try {
      const buf = await file.arrayBuffer();
      let bin = ""; const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      const b64 = btoa(bin);
      const { data: s } = await supabase.auth.getSession();
      const token = s?.session?.access_token;
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/html5-library-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          source_google_account_id: googleAccountId || null,
          source_campaign_id: campaignId,
          source_campaign_name: campaignName || null,
          source_ad_id: ad.ad_id,
          source_ad_name: ad.ad_name || null,
          zip_base64: b64,
          zip_filename: file.name,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || "falha");
      toast({ title: "ZIP salvo", description: ad.ad_name || ad.ad_id });
      qc.invalidateQueries({ queryKey: ["html5-library", campaignId] });
    } catch (e: any) {
      toast({ title: "Erro", description: String(e?.message || e), variant: "destructive" });
    } finally {
      setUploadingId(null);
    }
  };

  const ads = adsQ.data ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" title="Anexar ZIPs HTML5">
          <FileArchive className="h-3.5 w-3.5" /> HTML5
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Biblioteca HTML5 — {campaignName || campaignId}</DialogTitle>
          <DialogDescription>
            Anexe os .zip dos anúncios HTML5 desta campanha. Em migrações futuras, o sistema sobe automaticamente sem cair em "Pendentes".
          </DialogDescription>
        </DialogHeader>

        {adsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando anúncios…</p>
        ) : ads.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum anúncio HTML5 detectado nesta campanha.</p>
        ) : (
          <div className="space-y-2 max-h-[420px] overflow-y-auto">
            {ads.map((ad) => {
              const saved = savedByAd.get(ad.ad_id);
              const busy = uploadingId === ad.ad_id;
              return (
                <div key={ad.ad_id} className="flex items-center justify-between gap-3 p-3 rounded-md border">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">{ad.ad_name || "(sem nome)"}</div>
                    <div className="text-xs text-muted-foreground font-mono">id: {ad.ad_id}</div>
                    {saved && (
                      <div className="text-xs text-success mt-1 flex items-center gap-1">
                        <Check className="h-3 w-3" /> {saved.zip_filename}
                      </div>
                    )}
                  </div>
                  <Badge variant="outline" className="text-[10px]">{ad.ad_type || "?"}</Badge>
                  <Button asChild size="sm" variant={saved ? "outline" : "default"} disabled={busy}>
                    <label className="cursor-pointer">
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      <span className="ml-1.5">{busy ? "Enviando…" : saved ? "Substituir" : "Anexar ZIP"}</span>
                      <input
                        type="file"
                        accept=".zip,application/zip"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) upload(ad, f);
                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
