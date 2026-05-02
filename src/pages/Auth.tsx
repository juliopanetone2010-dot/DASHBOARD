import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";
import { BarChart3, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

const emailSchema = z.string().trim().email("E-mail inválido").max(255);
const pwSchema = z.string().min(8, "Mínimo 8 caracteres").max(72);
const nameSchema = z.string().trim().min(1).max(80);

const Auth = () => {
  const { session, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (session) return <Navigate to="/" replace />;

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      emailSchema.parse(email);
      pwSchema.parse(password);
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.errors[0].message : "Dados inválidos";
      toast({ title: "Erro", description: msg, variant: "destructive" });
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast({ title: "Falha no login", description: error.message, variant: "destructive" });
      return;
    }
    navigate("/", { replace: true });
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      nameSchema.parse(displayName);
      emailSchema.parse(email);
      pwSchema.parse(password);
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.errors[0].message : "Dados inválidos";
      toast({ title: "Erro", description: msg, variant: "destructive" });
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
        data: { display_name: displayName },
      },
    });
    setLoading(false);
    if (error) {
      toast({ title: "Falha no cadastro", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Conta criada", description: "Bem-vindo!" });
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-xl bg-gradient-primary flex items-center justify-center shadow-glow">
            <BarChart3 className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Arbitrage Engine</h1>
          <p className="text-sm text-muted-foreground">Google Ads × Ad Manager — automação de ROI</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-elegant">
          <Tabs defaultValue="signin">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="signin">Entrar</TabsTrigger>
              <TabsTrigger value="signup">Criar conta</TabsTrigger>
            </TabsList>

            <TabsContent value="signin" asChild>
              <form onSubmit={handleSignIn} className="space-y-4 pt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="si-email">E-mail</Label>
                  <Input id="si-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="si-pw">Senha</Label>
                  <Input id="si-pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Entrar
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup" asChild>
              <form onSubmit={handleSignUp} className="space-y-4 pt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="su-name">Nome</Label>
                  <Input id="su-name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="su-email">E-mail</Label>
                  <Input id="su-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="su-pw">Senha (mín. 8)</Label>
                  <Input id="su-pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Criar conta
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
};

export default Auth;
