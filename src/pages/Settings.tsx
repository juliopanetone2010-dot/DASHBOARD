import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CheckCircle2, ExternalLink, KeyRound, Plug, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface ApiSetStatus {
  api_set: number;
  client_id: boolean;
  client_secret: boolean;
  developer_token: boolean;
  configured: boolean;
}

interface StatusResp {
  google_client_id: boolean;
  google_client_secret: boolean;
  google_ads_developer_token: boolean;
  configured: boolean;
  api_sets?: ApiSetStatus[];
  configured_api_sets?: number[];
  default_api_set?: number;
}

export default function Settings() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiSet, setApiSet] = useState(1);

  const fetchStatus = async () => {
    const { data, error } = await supabase.functions.invoke<StatusResp>("google-ads-oauth-status");
    if (error) { toast({ title: "Erro ao consultar status", variant: "destructive" }); return; }
    setStatus(data ?? null);
    if (data?.default_api_set) setApiSet(data.default_api_set);
  };

  useEffect(() => { fetchStatus(); }, []);

  const handleConnect = async () => {
    setLoading(true);
    const redirectUri = `${window.location.origin}/oauth/google-ads/callback`;
    // Sem inputs manuais — o callback descobre os customer_ids via API.
    sessionStorage.setItem("oauth_pending", JSON.stringify({ account_name: `MCC (API ${apiSet})`, api_set: apiSet }));
    try {
      const projectId = (import.meta as unknown as { env: Record<string, string> }).env.VITE_SUPABASE_PROJECT_ID;
      const fnUrl = `https://${projectId}.supabase.co/functions/v1/google-ads-oauth-start?redirect_uri=${encodeURIComponent(redirectUri)}&api_set=${apiSet}`;
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

          <div className="space-y-4 mb-2">
            {(status?.api_sets ?? []).map((s) => (
              <div key={s.api_set} className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">
                    Conjunto {s.api_set} {s.api_set === 1 ? "(MCC original)" : ""}
                  </span>
                  {s.configured ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
                      <CheckCircle2 className="h-3.5 w-3.5" /> pronto
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <XCircle className="h-3.5 w-3.5" /> vazio
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  <Row ok={s.client_id} label={`GOOGLE_CLIENT_ID_${s.api_set}`} />
                  <Row ok={s.client_secret} label={`GOOGLE_CLIENT_SECRET_${s.api_set}`} />
                  <Row ok={s.developer_token} label={`GOOGLE_ADS_DEVELOPER_TOKEN_${s.api_set}`} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Cada conjunto corresponde a uma MCC / developer token diferente. O conjunto 1 aceita também os
            secrets legados sem sufixo. Para adicionar uma nova MCC, peça para salvar
            <code className="font-mono"> GOOGLE_CLIENT_ID_2</code>, <code className="font-mono">GOOGLE_CLIENT_SECRET_2</code> e
            <code className="font-mono"> GOOGLE_ADS_DEVELOPER_TOKEN_2</code>.
          </p>
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

          <div className="space-y-1 mb-3 max-w-xs">
            <Label className="text-xs">Conjunto de credenciais (API)</Label>
            <select
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={apiSet}
              onChange={(e) => setApiSet(Number(e.target.value))}
            >
              {(status?.api_sets ?? []).map((s) => (
                <option key={s.api_set} value={s.api_set} disabled={!s.configured}>
                  Conjunto {s.api_set}{s.api_set === 1 ? " (MCC original)" : ""}{s.configured ? "" : " — não configurado"}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <Button
              onClick={handleConnect}
              disabled={loading || !(status?.configured_api_sets ?? []).includes(apiSet)}
              className="gap-1.5"
            >
              <Plug className="h-3.5 w-3.5" /> Conectar Google Ads (MCC)
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="https://developers.google.com/google-ads/api/docs/oauth/overview" target="_blank" rel="noreferrer">
                Docs <ExternalLink className="h-3 w-3 ml-1.5" />
              </a>
            </Button>
            {!(status?.configured_api_sets ?? []).includes(apiSet) && (
              <span className="text-xs text-destructive">Configure os secrets do conjunto {apiSet} antes de conectar.</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">
            Redirect URI: <code className="font-mono">{typeof window !== "undefined" ? `${window.location.origin}/oauth/google-ads/callback` : ""}</code>
          </p>
        </section>
      </main>
    </div>
  );
}
