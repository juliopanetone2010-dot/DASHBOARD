import { ExternalLink, Copy, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface Props {
  url?: string | null;
  className?: string;
  compact?: boolean;
}

export function FinalUrlActions({ url, className, compact }: Props) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast({ title: "Link copiado", description: url });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Falha ao copiar", variant: "destructive" });
    }
  };

  return (
    <div className={cn("inline-flex items-center gap-1 max-w-full", className)}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "truncate text-xs text-primary hover:underline",
          compact ? "max-w-[200px]" : "max-w-[320px]",
        )}
        title={url}
      >
        {url}
      </a>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 shrink-0"
        title="Abrir página"
        asChild
      >
        <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          <ExternalLink className="h-3 w-3" />
        </a>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 shrink-0"
        title="Copiar link"
        onClick={handleCopy}
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
}
