import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
