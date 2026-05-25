import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CheckCircle2, ExternalLink, KeyRound, Plug, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface StatusResp {
  google_client_id: boolean;
  google_client_secret: boolean;
  google_ads_developer_token: boolean;
  configured: boolean;
}

export default function Settings() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = async () => {
    const { data, error } = await supabase.functions.invoke<StatusResp>("google-ads-oauth-status");
    if (error) { toast({ title: "Erro ao consultar status", variant: "destructive" }); return; }
    setStatus(data ?? null);
  };

  useEffect(() => { fetchStatus(); }, []);

  const handleConnect = async () => {
    setLoading(true);
    const redirectUri = `${window.location.origin}/oauth/google-ads/callback`;
    // Sem inputs manuais — o callback descobre os customer_ids via API.
    sessionStorage.setItem("oauth_pending", JSON.stringify({ account_name: "MCC" }));
    try {
      const projectId = (import.meta as unknown as { env: Record<string, string> }).env.VITE_SUPABASE_PROJECT_ID;
      const fnUrl = `https://${projectId}.supabase.co/functions/v1/google-ads-oauth-start?redirect_uri=${encodeURIComponent(redirectUri)}`;
      const res = await fetch(fnUrl);
      const j = await res.json();
      if (!j.auth_url) {
        toast({ title: "Configuração incompleta", description: j.error ?? "Falhou", variant: "destructive" });
        setLoading(false);
        return;
      }
      window.location.href = j.auth_url;
    } catch (e) {
      toast({ title: "Erro ao iniciar OAuth", description: String(e), variant: "destructive" });
      setLoading(false);
    }
  };

  const Row = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center justify-between py-2 border-b border-border/60 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      {ok ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
          <CheckCircle2 className="h-3.5 w-3.5" /> configurado
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
          <XCircle className="h-3.5 w-3.5" /> faltando
        </span>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-10">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/"><ArrowLeft className="h-4 w-4 mr-1" /> Voltar</Link>
            </Button>
            <h1 className="text-lg font-semibold">Configurações · OAuth Google Ads</h1>
          </div>
          <ShieldCheck className="h-4 w-4 text-success" />
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-3xl space-y-6">
        <section className="rounded-xl border border-border bg-card p-6 shadow-elegant">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-gradient-primary flex items-center justify-center">
              <KeyRound className="h-4 w-4 text-primary-foreground" />
            </div>
            <div>
              <h2 className="font-semibold">Credenciais (armazenadas como secrets)</h2>
              <p className="text-xs text-muted-foreground">Nunca expostas no frontend.</p>
            </div>
          </div>

          <div className="space-y-1 mb-4">
            <Row ok={!!status?.google_client_id} label="GOOGLE_CLIENT_ID" />
            <Row ok={!!status?.google_client_secret} label="GOOGLE_CLIENT_SECRET" />
            <Row ok={!!status?.google_ads_developer_token} label="GOOGLE_ADS_DEVELOPER_TOKEN" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">GOOGLE_CLIENT_ID</Label>
              <Input type="password" value={status?.google_client_id ? "••••••••••••" : ""} readOnly placeholder="não configurado" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">GOOGLE_CLIENT_SECRET</Label>
              <Input type="password" value={status?.google_client_secret ? "••••••••••••" : ""} readOnly placeholder="não configurado" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">GOOGLE_ADS_DEVELOPER_TOKEN</Label>
              <Input type="password" value={status?.google_ads_developer_token ? "••••••••••••" : ""} readOnly placeholder="não configurado" />
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-6 shadow-elegant">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-lg bg-accent flex items-center justify-center">
              <Plug className="h-4 w-4 text-accent-foreground" />
            </div>
            <div>
              <h2 className="font-semibold">Conectar MCC Google Ads</h2>
              <p className="text-xs text-muted-foreground">
                Sem digitar Customer ID. Após autorizar, o sistema descobre as contas automaticamente.
              </p>
            </div>
          </div>

          <ol className="text-xs text-muted-foreground space-y-1 mb-4 list-decimal list-inside">
            <li>Você é redirecionado para o Google e autoriza acesso ao MCC.</li>
            <li>O backend troca o code por um <code>refresh_token</code> e salva no MCC.</li>
            <li>Em seguida, em <strong>Integrações</strong>, clique em <em>Sincronizar contas do MCC</em> para importar as sub-contas.</li>
          </ol>

          <div className="flex flex-wrap gap-2 items-center">
            <Button onClick={handleConnect} disabled={loading || !status?.configured} className="gap-1.5">
              <Plug className="h-3.5 w-3.5" /> Conectar Google Ads (MCC)
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="https://developers.google.com/google-ads/api/docs/oauth/overview" target="_blank" rel="noreferrer">
                Docs <ExternalLink className="h-3 w-3 ml-1.5" />
              </a>
            </Button>
            {!status?.configured && (
              <span className="text-xs text-destructive">Configure os secrets antes de conectar.</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">
            Redirect URI: <code className="font-mono">{typeof window !== "undefined" ? `${window.location.origin}/oauth/google-ads/callback` : ""}</code>
          </p>
        </section>

        <section className="rounded-xl border border-border bg-card p-6 shadow-elegant">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">AI Providers</h2>
              <p className="text-xs text-muted-foreground">Conecte DeepSeek, OpenAI, OpenRouter, Claude ou Gemini ao AI Assistant.</p>
            </div>
            <Button asChild size="sm"><Link to="/ai-settings">Abrir</Link></Button>
          </div>
        </section>
      </main>
    </div>
  );
}
