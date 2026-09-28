// deno test supabase/functions/_shared/site_split_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { splitSiteMetricRowsByHost } from "./site_split.ts";

const sites = [
  { id: "dv", domain: "diariovagas.com" },
  { id: "fr", domain: "frjob.diariovagas.com" },
];

Deno.test("reparte o dia pelo host e o principal fica com o resto", () => {
  const rows = [{ date: "2026-09-28", impressions: 1000, measurable: 900, viewable: 800, revenue: 10 }];
  const hosts = new Map([["2026-09-28", new Map([
    ["diariovagas.com", { impr: 700, rev: 7 }],
    ["frjob.diariovagas.com", { impr: 250, rev: 2.5 }],
    ["ligado360.com.br", { impr: 50, rev: 0.5 }],
  ])]]);
  const out = splitSiteMetricRowsByHost(rows, sites, hosts);
  assertEquals(out.get("fr"), [{ date: "2026-09-28", impressions: 250, measurable: 225, viewable: 200, revenue: 2.5 }]);
  assertEquals(out.get("dv"), [{ date: "2026-09-28", impressions: 750, measurable: 675, viewable: 600, revenue: 7.5 }]);
});

Deno.test("site extra nunca passa do total do dia", () => {
  const rows = [{ date: "2026-09-28", impressions: 100, measurable: 90, viewable: 80, revenue: 1 }];
  const hosts = new Map([["2026-09-28", new Map([["frjob.diariovagas.com", { impr: 500, rev: 5 }]])]]);
  const out = splitSiteMetricRowsByHost(rows, sites, hosts);
  assertEquals(out.get("fr")![0].revenue, 1);
  assertEquals(out.get("fr")![0].impressions, 100);
  assertEquals(out.get("dv")![0].revenue, 0);
  assertEquals(out.get("dv")![0].impressions, 0);
});

Deno.test("sem dado do host tudo fica no principal", () => {
  const rows = [{ date: "2026-09-28", impressions: 100, measurable: 90, viewable: 80, revenue: 1 }];
  const out = splitSiteMetricRowsByHost(rows, sites, new Map());
  assertEquals(out.get("dv"), rows);
  assertEquals(out.get("fr"), [{ date: "2026-09-28", impressions: 0, measurable: 0, viewable: 0, revenue: 0 }]);
});
