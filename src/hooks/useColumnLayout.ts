import { useEffect, useState } from "react";

export interface ColumnPreset {
  name: string;
  order: string[];
  widths: Record<string, number>;
  visible: string[];
}

interface Options {
  storageKeyOrder: string;
  storageKeyWidths: string;
  storageKeyVisible: string;
  storageKeyPresets?: string;
  allKeys: string[];
  defaultWidths: Record<string, number>;
  minWidth?: number;
  maxWidth?: number;
}

export function useColumnLayout({
  storageKeyOrder,
  storageKeyWidths,
  storageKeyVisible,
  storageKeyPresets,
  allKeys,
  defaultWidths,
  minWidth = 60,
  maxWidth = 600,
}: Options) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(storageKeyOrder) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        // Merge: keep persisted order, append any new keys at the end, drop unknown
        const known = new Set(allKeys);
        const persisted = parsed.filter((k) => known.has(k));
        const missing = allKeys.filter((k) => !persisted.includes(k));
        return [...persisted, ...missing];
      }
    } catch { /* ignore */ }
    return [...allKeys];
  });

  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(storageKeyWidths) : null;
      if (raw) return { ...defaultWidths, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...defaultWidths };
  });

  const [visible, setVisible] = useState<Set<string>>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(storageKeyVisible) : null;
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set(allKeys);
  });

  useEffect(() => {
    try { window.localStorage.setItem(storageKeyOrder, JSON.stringify(order)); } catch { /* ignore */ }
  }, [order, storageKeyOrder]);

  useEffect(() => {
    try { window.localStorage.setItem(storageKeyWidths, JSON.stringify(widths)); } catch { /* ignore */ }
  }, [widths, storageKeyWidths]);

  useEffect(() => {
    try { window.localStorage.setItem(storageKeyVisible, JSON.stringify(Array.from(visible))); } catch { /* ignore */ }
  }, [visible, storageKeyVisible]);

  const toggleVisible = (k: string) =>
    setVisible((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const setWidth = (k: string, w: number) =>
    setWidths((cur) => ({ ...cur, [k]: Math.max(minWidth, Math.min(maxWidth, Math.round(w))) }));

  const resetAll = () => {
    setOrder([...allKeys]);
    setWidths({ ...defaultWidths });
    setVisible(new Set(allKeys));
  };

  // Pointer drag-resize utility — call from onPointerDown of the resize handle
  const startResize = (k: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[k] ?? defaultWidths[k] ?? 120;
    const onMove = (ev: PointerEvent) => {
      const next = startW + (ev.clientX - startX);
      setWidth(k, next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ---- Presets (named saved views) ----
  const presetsKey = storageKeyPresets ?? `${storageKeyOrder}::presets`;
  const [presets, setPresets] = useState<ColumnPreset[]>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(presetsKey) : null;
      if (raw) return JSON.parse(raw) as ColumnPreset[];
    } catch { /* ignore */ }
    return [];
  });
  useEffect(() => {
    try { window.localStorage.setItem(presetsKey, JSON.stringify(presets)); } catch { /* ignore */ }
  }, [presets, presetsKey]);

  const savePreset = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const snapshot: ColumnPreset = {
      name: trimmed,
      order: [...order],
      widths: { ...widths },
      visible: Array.from(visible),
    };
    setPresets((cur) => {
      const without = cur.filter((p) => p.name !== trimmed);
      return [...without, snapshot];
    });
  };

  const applyPreset = (name: string) => {
    const p = presets.find((x) => x.name === name);
    if (!p) return;
    const known = new Set(allKeys);
    const persisted = p.order.filter((k) => known.has(k));
    const missing = allKeys.filter((k) => !persisted.includes(k));
    setOrder([...persisted, ...missing]);
    setWidths({ ...defaultWidths, ...p.widths });
    setVisible(new Set(p.visible.filter((k) => known.has(k))));
  };

  const deletePreset = (name: string) => {
    setPresets((cur) => cur.filter((p) => p.name !== name));
  };

  return { order, setOrder, widths, setWidth, visible, toggleVisible, resetAll, startResize, presets, savePreset, applyPreset, deletePreset };
}
