export const fmtCurrency = (v: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(v ?? 0);

export const fmtPercent = (v: number) =>
  `${v >= 0 ? "+" : ""}${(v ?? 0).toFixed(2)}%`;

export const fmtNumber = (v: number) =>
  new Intl.NumberFormat("pt-BR").format(v ?? 0);

export const fmtDecimal = (v: number, digits = 2) =>
  new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v ?? 0);
