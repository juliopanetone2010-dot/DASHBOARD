import { useEffect, useRef, useState, type ReactNode } from "react";

// Barra de rolagem horizontal no topo, sincronizada com a da tabela (sem transform 3D,
// que trava o scroll e quebra colunas sticky no Safari/Mac).
export function TopScrollbar({ children }: { children: ReactNode }) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [clientW, setClientW] = useState(0);

  useEffect(() => {
    // O <Table> do shadcn já embrulha a <table> num div overflow-auto: esse é o scroller real.
    const scroller = bodyRef.current?.firstElementChild as HTMLElement | null;
    const top = topRef.current;
    if (!scroller || !top) return;

    const measure = () => {
      setWidth(scroller.scrollWidth);
      setClientW(scroller.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    const table = scroller.firstElementChild;
    if (table) ro.observe(table);

    let lock = false;
    const fromBody = () => {
      if (lock) { lock = false; return; }
      if (top.scrollLeft !== scroller.scrollLeft) { lock = true; top.scrollLeft = scroller.scrollLeft; }
    };
    const fromTop = () => {
      if (lock) { lock = false; return; }
      if (scroller.scrollLeft !== top.scrollLeft) { lock = true; scroller.scrollLeft = top.scrollLeft; }
    };
    scroller.addEventListener("scroll", fromBody, { passive: true });
    top.addEventListener("scroll", fromTop, { passive: true });
    return () => {
      ro.disconnect();
      scroller.removeEventListener("scroll", fromBody);
      top.removeEventListener("scroll", fromTop);
    };
  }, []);

  const overflowing = width > clientW + 1;

  return (
    <div>
      <div
        ref={topRef}
        className="overflow-x-auto overflow-y-hidden"
        style={{ display: overflowing ? "block" : "none" }}
        aria-hidden
      >
        <div style={{ width, height: 12 }} />
      </div>
      <div ref={bodyRef}>{children}</div>
    </div>
  );
}
