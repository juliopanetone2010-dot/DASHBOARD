import { useEffect, useRef, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Bot, Plus, Send, Loader2, Trash2, ChevronRight, Wrench, KeyRound, Zap, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export interface AiContext {
  active_tab: string;
  current_site?: string | null;
  current_site_name?: string | null;
  range?: { from: string; to: string } | null;
  filters?: Record<string, unknown>;
  selected_campaign?: { campaign_id: string; name?: string } | null;
  selected_placement?: string | null;
  selected_country?: string | null;
  loaded_data?: Record<string, unknown>;
  debug?: boolean;
}

interface ThreadRow { id: string; title: string; active_tab: string | null; updated_at: string }
interface MessageRow {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  parts: { tool_events?: Array<{ name: string; args: unknown; result: unknown }>; tool_calls?: unknown } | null;
  created_at: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: AiContext;
  suggestions?: string[];
}

export function AiAssistant({ open, onOpenChange, context, suggestions = [] }: Props) {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [debug, setDebug] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Carrega threads ao abrir
  useEffect(() => {
    if (!open) return;
    (async () => {
      const { data } = await supabase
        .from("ai_threads")
        .select("id, title, active_tab, updated_at")
        .order("updated_at", { ascending: false })
        .limit(50);
      setThreads((data ?? []) as ThreadRow[]);
    })();
  }, [open]);

  // Carrega mensagens da thread ativa
  useEffect(() => {
    if (!activeThreadId) { setMessages([]); return; }
    (async () => {
      const { data } = await supabase
        .from("ai_messages")
        .select("id, role, content, parts, created_at")
        .eq("thread_id", activeThreadId)
        .order("created_at");
      setMessages((data ?? []) as MessageRow[]);
    })();
  }, [activeThreadId]);

  // Auto-foco e scroll
  useEffect(() => { if (open) setTimeout(() => textareaRef.current?.focus(), 100); }, [open, activeThreadId]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  const newThread = () => { setActiveThreadId(null); setMessages([]); setTimeout(() => textareaRef.current?.focus(), 50); };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    // optimistic
    const tempId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: "user", content: text, parts: null, created_at: new Date().toISOString() }]);
    try {
      const { data, error } = await supabase.functions.invoke("ai-assistant", {
        body: { thread_id: activeThreadId, message: text, context: { ...context, debug } },
      });
      if (error) throw error;
      const result = data as { thread_id: string; content: string; tool_events: Array<{ name: string; args: unknown; result: unknown }> };
      // refresh
      setActiveThreadId(result.thread_id);
      const { data: refreshed } = await supabase.from("ai_messages")
        .select("id, role, content, parts, created_at")
        .eq("thread_id", result.thread_id).order("created_at");
      setMessages((refreshed ?? []) as MessageRow[]);
      // atualiza lista de threads
      const { data: ts } = await supabase.from("ai_threads").select("id, title, active_tab, updated_at").order("updated_at", { ascending: false }).limit(50);
      setThreads((ts ?? []) as ThreadRow[]);
    } catch (e) {
      toast({ title: "Erro no AI", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      setMessages((m) => m.filter((x) => x.id !== tempId));
    } finally {
      setSending(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  };

  const deleteThread = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await supabase.from("ai_threads").delete().eq("id", id);
    setThreads((t) => t.filter((x) => x.id !== id));
    if (activeThreadId === id) newThread();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[900px] p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4" />
            AI Auditor — {context.active_tab}
            {context.current_site_name && <Badge variant="secondary" className="ml-2">{context.current_site_name}</Badge>}
            {context.selected_placement && <Badge variant="outline" className="font-mono text-xs">{context.selected_placement}</Badge>}
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
                Debug
              </label>
              <Button size="sm" variant="outline" onClick={newThread} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" /> Nova
              </Button>
            </div>
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-1 min-h-0">
          {/* Threads sidebar */}
          <aside className="w-56 border-r flex flex-col">
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {threads.length === 0 && <div className="text-xs text-muted-foreground p-2">Nenhuma conversa ainda.</div>}
                {threads.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => setActiveThreadId(t.id)}
                    className={cn(
                      "group flex items-center gap-1 rounded px-2 py-1.5 text-xs cursor-pointer hover:bg-muted",
                      activeThreadId === t.id && "bg-muted"
                    )}
                  >
                    <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    <div className="flex-1 truncate">
                      <div className="truncate font-medium">{t.title}</div>
                      {t.active_tab && <div className="truncate text-[10px] text-muted-foreground">{t.active_tab}</div>}
                    </div>
                    <button onClick={(e) => deleteThread(t.id, e)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </aside>

          {/* Conversation */}
          <div className="flex-1 flex flex-col min-w-0">
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {messages.length === 0 && !sending && (
                <div className="text-sm text-muted-foreground space-y-3">
                  <p>Faça uma pergunta sobre a aba <b>{context.active_tab}</b>. O AI tem acesso aos dados e usa tools para investigar.</p>
                  {suggestions.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                      {suggestions.map((s) => (
                        <button key={s} onClick={() => send(s)} className="text-left text-xs border rounded-md p-2 hover:bg-muted">
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {messages.map((m) => {
                if (m.role === "tool" && m.parts?.tool_events) {
                  return (
                    <details key={m.id} className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                      <summary className="cursor-pointer flex items-center gap-1.5 text-muted-foreground">
                        <Wrench className="h-3 w-3" /> {m.parts.tool_events.length} tool call{m.parts.tool_events.length > 1 ? "s" : ""}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {m.parts.tool_events.map((ev, i) => (
                          <div key={i} className="border-l-2 border-primary/40 pl-2">
                            <div className="font-mono text-[11px] font-semibold">{ev.name}</div>
                            <details className="mt-1">
                              <summary className="cursor-pointer text-[10px] text-muted-foreground">args</summary>
                              <pre className="text-[10px] mt-1 overflow-auto max-h-48">{JSON.stringify(ev.args, null, 2)}</pre>
                            </details>
                            <details>
                              <summary className="cursor-pointer text-[10px] text-muted-foreground">result</summary>
                              <pre className="text-[10px] mt-1 overflow-auto max-h-64">{JSON.stringify(ev.result, null, 2)}</pre>
                            </details>
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                }
                if (m.role === "user") {
                  return (
                    <div key={m.id} className="flex justify-end">
                      <div className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm max-w-[80%] whitespace-pre-wrap">
                        {m.content}
                      </div>
                    </div>
                  );
                }
                if (m.role === "assistant") {
                  return (
                    <div key={m.id} className="text-sm prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown>{m.content ?? ""}</ReactMarkdown>
                    </div>
                  );
                }
                return null;
              })}
              {sending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Investigando…
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="border-t p-3">
              <div className="flex gap-2 items-end">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder={`Perguntar sobre ${context.active_tab}…`}
                  className="min-h-[44px] max-h-32 resize-none"
                  disabled={sending}
                />
                <Button onClick={() => send()} disabled={sending || !input.trim()} size="icon">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface ButtonProps {
  context: AiContext;
  suggestions?: string[];
  label?: string;
}
export function AiAssistantButton({ context, suggestions, label = "Perguntar ao AI" }: ButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="gap-1.5">
        <Bot className="h-3.5 w-3.5" /> {label}
      </Button>
      {open && <AiAssistant open={open} onOpenChange={setOpen} context={context} suggestions={suggestions} />}
    </>
  );
}

// silence unused
void Input;
