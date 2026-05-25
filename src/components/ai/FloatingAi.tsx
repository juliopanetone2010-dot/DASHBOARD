import { useState } from "react";
import { Bot } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { AiAssistant, type AiContext } from "./AiAssistant";

export function FloatingAi() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const location = useLocation();

  if (!user) return null;
  if (location.pathname === "/auth") return null;

  const context: AiContext = {
    active_tab: "global",
    page: location.pathname,
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Abrir AI Assistant"
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-primary-foreground shadow-lg hover:opacity-90 transition"
      >
        <Bot className="h-5 w-5" />
        <span className="text-sm font-medium hidden sm:inline">AI Assistant</span>
      </button>
      {open && (
        <AiAssistant open={open} onOpenChange={setOpen} context={context} />
      )}
    </>
  );
}
