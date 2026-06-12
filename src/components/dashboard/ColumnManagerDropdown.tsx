import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Columns3, GripVertical, RotateCcw, Save, Trash2, Check } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ColumnPreset } from "@/hooks/useColumnLayout";

export interface ColumnOption {
  key: string;
  label: string;
}

interface Props {
  columns: ColumnOption[];
  order: string[];
  visible: Set<string>;
  onOrderChange: (next: string[]) => void;
  onToggleVisible: (key: string) => void;
  onReset: () => void;
  presets?: ColumnPreset[];
  onSavePreset?: (name: string) => void;
  onApplyPreset?: (name: string) => void;
  onDeletePreset?: (name: string) => void;
}

function SortableItem({
  col,
  visible,
  onToggle,
}: {
  col: ColumnOption;
  visible: boolean;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: col.key,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1.5 rounded-md px-1 py-1 text-xs hover:bg-muted"
    >
      <button
        type="button"
        className="cursor-grab touch-none p-0.5 text-muted-foreground hover:text-foreground"
        {...attributes}
        {...listeners}
        aria-label="Arrastar para reordenar"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <Checkbox checked={visible} onCheckedChange={onToggle} />
      <span className="flex-1 select-none">{col.label}</span>
    </div>
  );
}

export function ColumnManagerDropdown({
  columns,
  order,
  visible,
  onOrderChange,
  onToggleVisible,
  onReset,
  presets = [],
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
}: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [newName, setNewName] = useState("");
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = order.indexOf(String(active.id));
    const newIdx = order.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    onOrderChange(arrayMove(order, oldIdx, newIdx));
  };

  const orderedCols = order
    .map((k) => columns.find((c) => c.key === k))
    .filter((x): x is ColumnOption => !!x);

  const handleSave = () => {
    if (!newName.trim() || !onSavePreset) return;
    onSavePreset(newName);
    setNewName("");
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs">
          <Columns3 className="h-3.5 w-3.5" />
          Colunas ({visible.size}/{columns.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-xs font-semibold">Personalizar colunas</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
            onClick={onReset}
          >
            <RotateCcw className="h-3 w-3" /> Restaurar
          </button>
        </div>

        {onSavePreset && (
          <div className="mb-2 rounded-md border bg-muted/30 p-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Minhas visões salvas
            </div>
            {presets.length === 0 && (
              <p className="px-0.5 pb-1.5 text-[10px] text-muted-foreground">
                Nenhuma visão salva ainda.
              </p>
            )}
            {presets.length > 0 && (
              <div className="mb-2 space-y-1">
                {presets.map((p) => (
                  <div
                    key={p.name}
                    className="flex items-center gap-1 rounded-md bg-background px-1.5 py-1 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => onApplyPreset?.(p.name)}
                      className="flex flex-1 items-center gap-1 truncate text-left hover:text-primary"
                      title={`Aplicar visão "${p.name}"`}
                    >
                      <Check className="h-3 w-3 shrink-0 text-primary" />
                      <span className="truncate">{p.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeletePreset?.(p.name)}
                      className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Apagar visão ${p.name}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSave();
                  }
                }}
                placeholder="Nome da visão"
                className="h-7 text-xs"
              />
              <Button
                size="sm"
                variant="default"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={handleSave}
                disabled={!newName.trim()}
              >
                <Save className="h-3 w-3" /> Salvar
              </Button>
            </div>
            <p className="mt-1 px-0.5 text-[10px] text-muted-foreground">
              Salva ordem, largura e colunas visíveis.
            </p>
          </div>
        )}

        <p className="px-1 pb-2 text-[10px] text-muted-foreground">
          Arraste para reordenar. Desmarque para ocultar.
        </p>
        <div className="max-h-80 overflow-y-auto">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              {orderedCols.map((col) => (
                <SortableItem
                  key={col.key}
                  col={col}
                  visible={visible.has(col.key)}
                  onToggle={() => onToggleVisible(col.key)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </PopoverContent>
    </Popover>
  );
}
