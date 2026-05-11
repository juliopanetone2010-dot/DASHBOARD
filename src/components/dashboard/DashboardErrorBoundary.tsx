import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  tabName: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// Per-tab error boundary. Catches render errors in a single tab so that one
// broken aba (e.g. a malformed payload from an upstream query) no longer
// cascades and takes the whole dashboard down with it. The other tabs keep
// working; the user gets a friendly retry affordance.
export class DashboardErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to console for ops; could be wired to a reporter (Sentry) later.
    console.error(`[DashboardErrorBoundary] tab="${this.props.tabName}"`, error, info);
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 my-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 space-y-3">
            <div>
              <h3 className="font-semibold text-foreground">
                A aba "{this.props.tabName}" não pôde ser carregada
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Houve um erro ao renderizar esta aba. As outras abas continuam funcionando.
                Tente recarregar — se o erro persistir, recarregue a página inteira.
              </p>
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground select-none">
                Detalhes técnicos
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono rounded border border-border bg-muted/40 p-3">
                {this.state.error?.message ?? "—"}
              </pre>
            </details>
            <Button variant="outline" size="sm" onClick={this.reset} className="gap-1.5">
              <RefreshCcw className="h-3.5 w-3.5" /> Tentar novamente
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
