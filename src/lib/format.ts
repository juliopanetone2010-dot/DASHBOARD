export const fmtCurrency = (v: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(v);

export const fmtPercent = (v: number) =>
  `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
