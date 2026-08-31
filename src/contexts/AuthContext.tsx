import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /** true when running with VITE_DEV_BYPASS_AUTH and no real Supabase user. */
  devBypass: boolean;
  signOut: () => Promise<void>;
}

// --- Temporary dev auth bypass ------------------------------------------------
// Flip VITE_DEV_BYPASS_AUTH back to "false" (or remove it) to restore the real
// login flow. Nothing about the auth structure is deleted.
export const DEV_BYPASS_AUTH = import.meta.env.VITE_DEV_BYPASS_AUTH === "true";
const DEV_LOGIN_EMAIL = (import.meta.env.VITE_DEV_LOGIN_EMAIL as string | undefined)?.trim() || "";
const DEV_LOGIN_PASSWORD = (import.meta.env.VITE_DEV_LOGIN_PASSWORD as string | undefined) || "";
const DEV_USER_ID =
  (import.meta.env.VITE_DEV_USER_ID as string | undefined)?.trim() ||
  "1b0affc0-d2e9-4f5c-87fc-3776e04bc3e9";
// When true we auto sign-in a real user (RLS + edge functions get a valid JWT).
const DEV_AUTOLOGIN = DEV_BYPASS_AUTH && !!DEV_LOGIN_EMAIL && !!DEV_LOGIN_PASSWORD;
// When true we run a fake client-only session (UI renders, data may be empty).
const DEV_FAKE_SESSION = DEV_BYPASS_AUTH && !DEV_AUTOLOGIN;

const fakeUser = {
  id: DEV_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "dev-bypass@local",
  app_metadata: { provider: "dev-bypass" },
  user_metadata: {},
  created_at: new Date(0).toISOString(),
} as unknown as User;

const fakeSession = {
  access_token: "dev-bypass",
  refresh_token: "dev-bypass",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: fakeUser,
} as unknown as Session;

const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  loading: true,
  devBypass: false,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(DEV_FAKE_SESSION ? fakeSession : null);
  const [loading, setLoading] = useState(!DEV_FAKE_SESSION);

  useEffect(() => {
    if (DEV_FAKE_SESSION) {
      // No real auth — nothing to hydrate.
      setSession(fakeSession);
      setLoading(false);
      return;
    }

    // 1. Listener PRIMEIRO (regra obrigatória)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setLoading(false);
    });

    // 2. Hidrata sessão atual e valida o token (limpa sessões quebradas)
    supabase.auth.getSession().then(async ({ data }) => {
      const current = data.session;
      setSession(current);
      setLoading(false);

      // Dev auto-login: sign in a real user so RLS/edge functions work.
      if (DEV_AUTOLOGIN && !current) {
        const { error } = await supabase.auth.signInWithPassword({
          email: DEV_LOGIN_EMAIL,
          password: DEV_LOGIN_PASSWORD,
        });
        if (error) console.error("[auth] dev auto-login failed:", error.message);
        return;
      }

      if (current) {
        const { error } = await supabase.auth.getUser();
        const msg = error?.message?.toLowerCase() ?? "";
        const invalid =
          !!error &&
          (msg.includes("jwt") ||
            msg.includes("token") ||
            msg.includes("session") ||
            msg.includes("user not found"));
        if (invalid) {
          // Token/refresh token inválido em cache -> limpa para permitir novo login
          await supabase.auth.signOut({ scope: "local" }).catch(() => {});
          setSession(null);
        }
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    if (DEV_FAKE_SESSION) return; // nothing to sign out of
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        devBypass: DEV_FAKE_SESSION,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
