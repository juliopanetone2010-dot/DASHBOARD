import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export default function OAuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState("Trocando código por tokens…");

  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");
    if (err) { setState("error"); setMessage(err); return; }
    if (!code) { setState("error"); setMessage("Código ausente."); return; }

    const pending = JSON.parse(sessionStorage.getItem("oauth_pending") ?? "{}");
    sessionStorage.removeItem("oauth_pending");

    (async () => {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; message?: string; error?: string }>(
        "google-ads-oauth-callback",
        {
          body: {
            code,
            state,
            redirect_uri: `${window.location.origin}/oauth/google-ads/callback`,
            ...pending,
          },
        },
      );
      if (error || data?.error) {
        console.error("[OAuthCallback] Error Data:", data);
        console.error("[OAuthCallback] Invoke Error:", error);
        setState("error");
        const detailedMsg = data?.error || error?.message || "Erro desconhecido na conexão";
        setMessage(detailedMsg);
        return;
      }
      setState("ok");
      setMessage(data?.message ?? "Conta conectada");
      setTimeout(() => navigate("/settings", { replace: true }), 1500);
    })();
  }, [params, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="rounded-xl border border-border bg-card p-8 max-w-md w-full text-center shadow-elegant">
        {state === "working" && <Loader2 className="h-10 w-10 mx-auto animate-spin text-primary mb-4" />}
        {state === "ok" && <CheckCircle2 className="h-10 w-10 mx-auto text-success mb-4" />}
        {state === "error" && <XCircle className="h-10 w-10 mx-auto text-destructive mb-4" />}
        <h1 className="text-lg font-semibold mb-2">
          {state === "working" ? "Conectando…" : state === "ok" ? "Conectado" : "Erro"}
        </h1>
        <p className="text-sm text-muted-foreground mb-4 break-words">{message}</p>
        {state !== "working" && (
          <Button asChild size="sm"><Link to="/settings">Voltar para Configurações</Link></Button>
        )}
      </div>
    </div>
  );
}
