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
  // Novas contas conectadas nessa chamada — se o usuário já tem uma "conta de
  // referência" salva (Integrações → Exclusões de conta), oferece aplicar nelas.
  const [newCustomerIds, setNewCustomerIds] = useState<string[]>([]);
  const [exclusionsChoice, setExclusionsChoice] = useState<"idle" | "applying" | "done" | "skipped">("idle");
  const exclusionsSourceId = (() => {
    try { return localStorage.getItem("exclusions_source_account_id") ?? ""; } catch { return ""; }
  })();

  const applyExclusionsToNewAccounts = async () => {
    setExclusionsChoice("applying");
    try {
      await supabase.functions.invoke("sync-account-exclusions", {
        body: { source_account_id: exclusionsSourceId, target_customer_ids: newCustomerIds },
      });
    } finally {
      setExclusionsChoice("done");
    }
  };

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
      const { data, error } = await supabase.functions.invoke<{
        ok?: boolean; message?: string; error?: string; requires_login?: boolean;
        accessible_customers?: Array<{ cid: string; isMcc?: boolean }>;
      }>(
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
      const operationalIds = (data?.accessible_customers ?? []).filter((c) => !c.isMcc).map((c) => c.cid);
      if (operationalIds.length > 0 && exclusionsSourceId) {
        // Tem conta de referência salva e conta(s) operacional(is) nova(s) — pergunta
        // antes de sumir da tela, em vez de navegar direto.
        setNewCustomerIds(operationalIds);
        return;
      }
      setTimeout(() => navigate("/", { replace: true }), 1500);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

        {state === "ok" && newCustomerIds.length > 0 && exclusionsChoice === "idle" && (
          <div className="mb-4 rounded-lg border border-border bg-muted/30 p-3 text-left text-sm">
            <p className="mb-2">
              {newCustomerIds.length === 1 ? "Essa conta é nova" : `Essas ${newCustomerIds.length} contas são novas`}.
              Quer aplicar as <strong>exclusões de sites/apps</strong> que você já configurou noutra
              conta (sites próprios, categorias de app) nela também?
            </p>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setExclusionsChoice("skipped")}>Agora não</Button>
              <Button size="sm" onClick={applyExclusionsToNewAccounts}>Aplicar agora</Button>
            </div>
          </div>
        )}
        {exclusionsChoice === "applying" && (
          <p className="mb-4 text-xs text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Aplicando exclusões…
          </p>
        )}
        {exclusionsChoice === "done" && (
          <p className="mb-4 text-xs text-success">Exclusões aplicadas.</p>
        )}

        {state !== "working" && (exclusionsChoice === "idle" ? newCustomerIds.length === 0 : true) && (
          <Button asChild size="sm"><Link to="/">Voltar ao dashboard</Link></Button>
        )}
      </div>
    </div>
  );
}
