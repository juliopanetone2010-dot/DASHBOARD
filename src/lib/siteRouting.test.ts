import { describe, expect, it } from "vitest";
import { buildCampaignSiteMap, campaignBelongsToSite, normalizeHost, pickSiteForHosts, primarySiteByAccount } from "./siteRouting";

const sites = [
  { id: "dv", domain: "diariovagas.com" },
  { id: "fr", domain: "frjob.diariovagas.com" },
  { id: "ja", domain: "https://jardimastral.com.br/" },
];

describe("normalizeHost", () => {
  it("tira protocolo, www, caminho e porta", () => {
    expect(normalizeHost("https://www.FrJob.DiarioVagas.com:443/rec-lidl/?gclid=1")).toBe("frjob.diariovagas.com");
    expect(normalizeHost("https://jardimastral.com.br/")).toBe("jardimastral.com.br");
    expect(normalizeHost("diariovagas.com/es/rec-x")).toBe("diariovagas.com");
    expect(normalizeHost(null)).toBe("");
  });
});

describe("pickSiteForHosts", () => {
  it("prefere casamento exato ao sufixo", () => {
    expect(pickSiteForHosts(["frjob.diariovagas.com"], sites)).toBe("fr");
    expect(pickSiteForHosts(["diariovagas.com"], sites)).toBe("dv");
  });
  it("usa o domínio mais específico que for sufixo do host", () => {
    expect(pickSiteForHosts(["es.diariovagas.com"], sites)).toBe("dv");
  });
  it("sem casamento devolve null", () => {
    expect(pickSiteForHosts(["zayviral.com"], sites)).toBeNull();
  });
});

describe("primarySiteByAccount", () => {
  it("usa is_primary e cai no primeiro link quando não há principal", () => {
    const m = primarySiteByAccount([
      { google_account_id: "a", site_id: "fr", is_primary: false },
      { google_account_id: "a", site_id: "dv", is_primary: true },
      { google_account_id: "b", site_id: "fr", is_primary: false },
    ]);
    expect(m.get("a")).toBe("dv");
    expect(m.get("b")).toBe("fr");
  });
});

describe("buildCampaignSiteMap", () => {
  const links = [
    { google_account_id: "acc-diario", site_id: "dv", is_primary: true },
    { google_account_id: "acc-diario", site_id: "fr", is_primary: false },
    { google_account_id: "acc-jardim", site_id: "ja", is_primary: true },
  ];
  const campaigns = [
    { campaign_id: "111", google_account_id: "acc-diario" },
    { campaign_id: "222", google_account_id: "acc-diario" },
    { campaign_id: "333", google_account_id: "acc-diario" },
    { campaign_id: "444", google_account_id: "acc-jardim" },
  ];
  const finalUrls = [
    { campaign_id: "111", final_url: "https://frjob.diariovagas.com/rec-lidl-recrute-comment-postuler/" },
    { campaign_id: "222", final_url: "https://diariovagas.com/es/rec-recuperar-fotos/" },
    { campaign_id: "444", final_url: "https://jardimastral.com.br/rec-x/" },
  ];
  const map = buildCampaignSiteMap({ links, sites, campaigns, finalUrls });

  it("manda cada campanha da conta com dois sites para o site do domínio", () => {
    expect(map.get("111")).toBe("fr");
    expect(map.get("222")).toBe("dv");
  });
  it("sem URL final conhecida vai para o principal", () => {
    expect(map.get("333")).toBe("dv");
  });
  it("não mapeia contas com um site só", () => {
    expect(map.has("444")).toBe(false);
  });
  it("campaignBelongsToSite usa o mapa e cai no vínculo da conta", () => {
    expect(campaignBelongsToSite({ campaignId: "111", accountId: "acc-diario", siteId: "fr", links, campaignSite: map })).toBe(true);
    expect(campaignBelongsToSite({ campaignId: "111", accountId: "acc-diario", siteId: "dv", links, campaignSite: map })).toBe(false);
    expect(campaignBelongsToSite({ campaignId: "444", accountId: "acc-jardim", siteId: "ja", links, campaignSite: map })).toBe(true);
    expect(campaignBelongsToSite({ campaignId: "444", accountId: "acc-jardim", siteId: "dv", links, campaignSite: {} })).toBe(false);
  });
  it("sem conta multi-site o mapa fica vazio", () => {
    expect(buildCampaignSiteMap({ links: [links[2]], sites, campaigns, finalUrls }).size).toBe(0);
  });
});
