import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export default function OAuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState("Trocando código por tokens…");
  const ran = useRef(false);

  useEffect(() => {
    // The auth code is single-use — never let this run twice.
    if (ran.current) return;
    ran.current = true;

    const code = params.get("code");
    const stateParam = params.get("state");
    const err = params.get("error");
    if (err) { setState("error"); setMessage(err); return; }
    if (!code) { setState("error"); setMessage("Código ausente."); return; }

    const pending = JSON.parse(sessionStorage.getItem("oauth_pending") ?? "{}");
    sessionStorage.removeItem("oauth_pending");

    (async () => {
      const { data, error } = await supabase.functions.invoke<{ ok?: boolean; message?: string; error?: string; requires_login?: boolean }>(
        "google-ads-oauth-callback",
        {
          body: {
            code,
            state: stateParam,
            redirect_uri: `${window.location.origin}/oauth/google-ads/callback`,
            ...pending,
          },
        },
      );

      // On a non-2xx, supabase-js gives a FunctionsHttpError whose `context` is
      // the raw Response — dig the real { error } message out of its body.
      let bodyError: string | null = (data && "error" in data && data.error) ? (data.error as string) : null;
      let rawBody: string | null = null;
      if (!bodyError && error) {
        try {
          const ctx = (error as unknown as { context?: Response }).context;
          if (ctx && typeof ctx.text === "function") {
            rawBody = await ctx.clone().text();
            try {
              const j = JSON.parse(rawBody);
              bodyError = j?.error ?? rawBody;
              if (j?.google_status || j?.raw) {
                bodyError = `${bodyError}\n\n[google_status] ${j.google_status ?? "?"}\n[raw] ${String(j.raw ?? "").slice(0, 400)}`;
              }
            } catch { bodyError = rawBody; }
          }
        } catch { /* ignore */ }
      }

      if (error || bodyError) {
        console.error("[OAuthCallback] data:", data, "error:", error, "bodyError:", bodyError);
        setState("error");
        setMessage(bodyError || error?.message || "Erro desconhecido na conexão");
        return;
      }

      if (data?.requires_login) {
        setState("error");
        setMessage("Tokens recebidos, mas não há sessão para salvar. Configure VITE_DEV_LOGIN_* (ou faça login) e tente de novo.");
        return;
      }

      setState("ok");
      setMessage(data?.message ?? "Conta conectada");
      setTimeout(() => navigate("/", { replace: true }), 1500);
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
        <p className="text-sm text-muted-foreground mb-4 break-words whitespace-pre-wrap">{message}</p>
        {state !== "working" && (
          <Button asChild size="sm"><Link to="/">Voltar ao dashboard</Link></Button>
        )}
      </div>
    </div>
  );
}
