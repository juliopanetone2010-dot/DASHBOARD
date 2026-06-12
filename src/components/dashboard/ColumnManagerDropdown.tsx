import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Columns3, GripVertical, RotateCcw } from "lucide-react";
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
}: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = order.indexOf(String(active.id));
    const newIdx = order.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    onOrderChange(arrayMove(order, oldIdx, newIdx));
  };

  // Render in current order
  const orderedCols = order
    .map((k) => columns.find((c) => c.key === k))
    .filter((x): x is ColumnOption => !!x);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs">
          <Columns3 className="h-3.5 w-3.5" />
          Colunas ({visible.size}/{columns.length})
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
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
        <p className="px-1 pb-2 text-[10px] text-muted-foreground">
          Arraste para reordenar. Desmarque para ocultar.
        </p>
        <div className="max-h-96 overflow-y-auto">
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
