import { Trash2, Archive, AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface AccountActionsProps {
  accountId: string;
  accountName: string;
  onArchive: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

export function AccountActions({ accountId, accountName, onArchive, onRemove }: AccountActionsProps) {
  return (
    <div className="flex items-center gap-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-warning">
            <Archive className="h-3.5 w-3.5" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Arquivar conta?</AlertDialogTitle>
            <AlertDialogDescription>
              A conta <strong>{accountName}</strong> será marcada como inativa.
              Os dados históricos de ROI e Gastos <strong>serão preservados</strong> nos relatórios,
              mas a conta não aparecerá mais como vinculada no dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => onArchive(accountId)}>Arquivar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Exclusão IRREVERSÍVEL
            </AlertDialogTitle>
            <AlertDialogDescription>
              Você está prestes a apagar a conta <strong>{accountName}</strong> permanentemente.
              <br /><br />
              <span className="text-destructive font-bold">
                ISSO IRÁ REMOVER TODOS OS DADOS HISTÓRICOS DE ROI E GASTOS desta conta do seu dashboard.
              </span>
              <br /><br />
              Deseja continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => onRemove(accountId)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Excluir Permanentemente
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
