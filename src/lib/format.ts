// Convenção de moedas no app:
// - Spend (Google Ads) é armazenado em BRL nativo
// - Revenue (GAM) é armazenado em USD nativo
// - Profit/ROI/ROAS já são calculados convertendo revenue USD→BRL no backend
export const fmtBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(v ?? 0);

export const fmtUSD = (v: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(v ?? 0);

// Alias retrocompat: gasto/lucro padrão em BRL
export const fmtCurrency = fmtBRL;

export const fmtPercent = (v: number) =>
  `${v >= 0 ? "+" : ""}${(v ?? 0).toFixed(2)}%`;

export const fmtNumber = (v: number) =>
  new Intl.NumberFormat("pt-BR").format(v ?? 0);

export const fmtDecimal = (v: number, digits = 2) =>
  new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v ?? 0);
