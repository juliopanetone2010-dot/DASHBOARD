import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

// Barra de rolagem horizontal no topo, sincronizada com a da tabela (sem transform 3D,
// que trava o scroll e quebra colunas sticky no Safari/Mac).
export function TopScrollbar({ children }: { children: ReactNode }) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [clientW, setClientW] = useState(0);

  // O <Table> do shadcn embrulha a <table> num div overflow-auto: esse é o scroller real.
  // Ele pode ser remontado quando os dados carregam, então é sempre resolvido na hora.
  const getScroller = useCallback(() => bodyRef.current?.firstElementChild as HTMLElement | null, []);

  const measure = useCallback(() => {
    const s = getScroller();
    if (!s) return;
    setWidth(s.scrollWidth);
    setClientW(s.clientWidth);
  }, [getScroller]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let ro: ResizeObserver | null = null;
    const observe = () => {
      ro?.disconnect();
      ro = new ResizeObserver(measure);
      const s = getScroller();
      if (s) {
        ro.observe(s);
        if (s.firstElementChild) ro.observe(s.firstElementChild);
      }
      measure();
    };
    observe();
    const mo = new MutationObserver(observe);
    mo.observe(body, { childList: true });

    // scroll não borbulha, mas dá pra capturar no container.
    const onBodyScroll = (e: Event) => {
      const s = getScroller();
      const top = topRef.current;
      if (!s || !top || e.target !== s) return;
      if (top.scrollLeft !== s.scrollLeft) top.scrollLeft = s.scrollLeft;
    };
    body.addEventListener("scroll", onBodyScroll, { capture: true, passive: true });
    return () => {
      ro?.disconnect();
      mo.disconnect();
      body.removeEventListener("scroll", onBodyScroll, { capture: true });
    };
  }, [getScroller, measure]);

  const overflowing = width > clientW + 1;

  return (
    <div>
      <div
        ref={topRef}
        className="overflow-x-auto overflow-y-hidden"
        style={{ display: overflowing ? "block" : "none" }}
        onScroll={(e) => {
          const s = getScroller();
          const left = e.currentTarget.scrollLeft;
          if (s && s.scrollLeft !== left) s.scrollLeft = left;
        }}
        aria-hidden
      >
        <div style={{ width, height: 12 }} />
      </div>
      <div ref={bodyRef}>{children}</div>
    </div>
  );
}
