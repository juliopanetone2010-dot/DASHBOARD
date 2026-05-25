import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Brain, CheckCircle2, KeyRound, Loader2, Plug, Save, Trash2, XCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type Provider = "deepseek" | "openai" | "openrouter" | "claude" | "gemini";

interface ProviderItem {
  id: string;
  provider: Provider;
  model: string | null;
  base_url: string | null;
  enabled: boolean;
  is_active: boolean;
  has_api_key: boolean;
  last_tested_at: string | null;
  last_test_status: string | null;
  last_test_latency_ms: number | null;
  last_test_error: string | null;
}

const PROVIDERS: Array<{
  id: Provider; name: string; defaultModel: string; defaultBaseUrl: string;
  models: string[]; routable: boolean;
}> = [
  { id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-chat", defaultBaseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"], routable: true },
  { id: "openai", name: "OpenAI", defaultModel: "gpt-4o-mini", defaultBaseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o3-mini"], routable: true },
  { id: "openrouter", name: "OpenRouter", defaultModel: "openai/gpt-4o-mini", defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001", "deepseek/deepseek-chat"], routable: true },
  { id: "claude", name: "Claude (Anthropic)", defaultModel: "claude-3-5-sonnet-latest", defaultBaseUrl: "https://api.anthropic.com/v1",
    models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"], routable: false },
  { id: "gemini", name: "Gemini (Google)", defaultModel: "gemini-2.0-flash", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.0-flash", "gemini-1.5-pro"], routable: false },
];

async function call(action: string, payload: Record<string, unknown> = {}) {
  const { data, error } = await supabase.functions.invoke("ai-providers", { body: { action, ...payload } });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data;
}

function ProviderCard({
  meta, item, onChanged,
}: {
  meta: typeof PROVIDERS[number];
  item?: ProviderItem;
  onChanged: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(item?.model ?? meta.defaultModel);
  const [baseUrl, setBaseUrl] = useState(item?.base_url ?? meta.defaultBaseUrl);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    setModel(item?.model ?? meta.defaultModel);
    setBaseUrl(item?.base_url ?? meta.defaultBaseUrl);
  }, [item?.id, item?.model, item?.base_url, meta.defaultModel, meta.defaultBaseUrl]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await call("save", { provider: meta.id, api_key: apiKey || undefined, model, base_url: baseUrl });
      setApiKey("");
      toast({ title: `${meta.name} salvo` });
      onChanged();
    } catch (e) {
      toast({ title: "Erro ao salvar", description: String(e), variant: "destructive" });
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const r = await call("test", { provider: meta.id, api_key: apiKey || undefined, model, base_url: baseUrl });
      if (r.ok) {
        toast({ title: `${meta.name} OK`, description: `Modelo: ${r.model} · ${r.latency_ms}ms` });
      } else {
        toast({ title: `${meta.name} falhou`, description: r.error ?? "erro", variant: "destructive" });
      }
      onChanged();
    } catch (e) {
      toast({ title: "Erro no teste", description: String(e), variant: "destructive" });
    } finally { setTesting(false); }
  };

  const handleActivate = async () => {
    setActivating(true);
    try {
      await call("set_active", { provider: meta.id });
      toast({ title: `${meta.name} ativo` });
      onChanged();
    } catch (e) {
      toast({ title: "Erro", description: String(e), variant: "destructive" });
    } finally { setActivating(false); }
  };

  const handleDelete = async () => {
    if (!confirm(`Remover configuração do ${meta.name}?`)) return;
    try {
      await call("delete", { provider: meta.id });
      toast({ title: "Removido" });
      onChanged();
    } catch (e) {
      toast({ title: "Erro", description: String(e), variant: "destructive" });
    }
  };

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-gradient-primary flex items-center justify-center">
            <Brain className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <div className="font-semibold flex items-center gap-2">
              {meta.name}
              {item?.is_active && <Badge className="gap-1"><Zap className="h-3 w-3" /> ativo</Badge>}
              {!meta.routable && <Badge variant="outline" className="text-[10px]">em breve no assistant</Badge>}
            </div>
            <div className="text-xs text-muted-foreground">
              {item?.has_api_key ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <CheckCircle2 className="h-3 w-3" /> chave configurada
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <XCircle className="h-3 w-3" /> sem chave
                </span>
              )}
              {item?.last_test_status && (
                <span className="ml-3">
                  último teste:{" "}
                  {item.last_test_status === "ok" ? (
                    <span className="text-success">{item.last_test_latency_ms}ms</span>
                  ) : (
                    <span className="text-destructive">falhou</span>
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          {item?.has_api_key && !item.is_active && meta.routable && (
            <Button size="sm" variant="outline" onClick={handleActivate} disabled={activating}>
              {activating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              <span className="ml-1">Ativar</span>
            </Button>
          )}
          {item && (
            <Button size="sm" variant="ghost" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1 md:col-span-2">
          <Label className="text-xs">API Key</Label>
          <Input
            type="password" autoComplete="off"
            value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={item?.has_api_key ? "•••••••• (deixe em branco para manter)" : "cole sua API key"}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Modelo padrão</Label>
          <Select value={meta.models.includes(model) ? model : "custom"} onValueChange={(v) => {
            if (v !== "custom") setModel(v);
          }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {meta.models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              <SelectItem value="custom">Custom…</SelectItem>
            </SelectContent>
          </Select>
          <Input value={model} onChange={(e) => setModel(e.target.value)} className="mt-1 font-mono text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Base URL (opcional)</Label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono text-xs" />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          <span className="ml-1">Salvar</span>
        </Button>
        <Button onClick={handleTest} disabled={testing || (!apiKey && !item?.has_api_key)} size="sm" variant="outline">
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
          <span className="ml-1">Testar conexão</span>
        </Button>
      </div>

      {item?.last_test_error && (
        <pre className="text-[11px] text-destructive bg-destructive/10 rounded p-2 whitespace-pre-wrap overflow-x-auto">
          {item.last_test_error}
        </pre>
      )}
    </Card>
  );
}

export default function AiSettings() {
  const [items, setItems] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const r = await call("list");
      setItems(r.items ?? []);
    } catch (e) {
      toast({ title: "Erro ao carregar", description: String(e), variant: "destructive" });
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const byProvider = useMemo(() => {
    const map = new Map<string, ProviderItem>();
    for (const it of items) map.set(it.provider, it);
    return map;
  }, [items]);

  const active = items.find((i) => i.is_active);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-10">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/"><ArrowLeft className="h-4 w-4 mr-1" /> Voltar</Link>
            </Button>
            <h1 className="text-lg font-semibold">AI Providers</h1>
          </div>
          <KeyRound className="h-4 w-4 text-muted-foreground" />
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-4xl space-y-6">
        <Card className="p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Provider ativo do AI Assistant</div>
            <div className="font-semibold mt-0.5">
              {active
                ? `${PROVIDERS.find(p => p.id === active.provider)?.name ?? active.provider} · ${active.model}`
                : "Lovable AI (padrão)"}
            </div>
          </div>
          {active && (
            <Button variant="outline" size="sm" onClick={async () => {
              await call("clear_active"); toast({ title: "Voltou para Lovable AI" }); load();
            }}>Usar Lovable AI</Button>
          )}
        </Card>

        <div className="text-xs text-muted-foreground">
          Conecte um provider externo. A API key é criptografada (AES-GCM) antes de salvar e nunca volta ao frontend.
          As tools internas do sistema (queries no banco, GAM, Google Ads) continuam rodando aqui — só a resposta final
          é gerada pelo provider escolhido.
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> carregando…
          </div>
        ) : (
          <div className="space-y-4">
            {PROVIDERS.map((p) => (
              <ProviderCard key={p.id} meta={p} item={byProvider.get(p.id)} onChanged={load} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
