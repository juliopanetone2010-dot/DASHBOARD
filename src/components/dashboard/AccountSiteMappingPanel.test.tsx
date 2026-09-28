import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountSiteMappingPanel } from "./AccountSiteMappingPanel";
import type { AccountSiteLink, GoogleAccount, Site } from "@/types/domain";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

const accounts = [
  { id: "acc-diario", customer_id: "2081415362", account_name: "[1] [DIARIO] [DEMANDA]", currency: "BRL", is_mcc: false },
] as unknown as GoogleAccount[];
const sites = [
  { id: "dv", name: "DiarioVagas", domain: "diariovagas.com", network_code: "23123711559" },
  { id: "fr", name: "FR Job", domain: "frjob.diariovagas.com", network_code: "23123711559" },
] as unknown as Site[];

function setup(links: AccountSiteLink[]) {
  const onAddLink = vi.fn().mockResolvedValue(undefined);
  const onRemoveLink = vi.fn().mockResolvedValue(undefined);
  render(
    <AccountSiteMappingPanel
      accounts={accounts} sites={sites} links={links} isGuest={false}
      onAddLink={onAddLink} onRemoveLink={onRemoveLink} onRefresh={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  return { onAddLink, onRemoveLink };
}

describe("AccountSiteMappingPanel com vários sites", () => {
  it("adiciona um site extra sem mexer no principal", async () => {
    const { onAddLink, onRemoveLink } = setup([
      { id: "l1", user_id: "u", google_account_id: "acc-diario", site_id: "dv", is_primary: true },
    ]);
    expect(screen.getByText("Outros sites nesta conta")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Salvar Mapeamento/ }));
    await waitFor(() => expect(onAddLink).toHaveBeenCalledWith("acc-diario", "fr", false));
    expect(onRemoveLink).not.toHaveBeenCalled();
  });

  it("remove o site extra desmarcado", async () => {
    const { onAddLink, onRemoveLink } = setup([
      { id: "l1", user_id: "u", google_account_id: "acc-diario", site_id: "dv", is_primary: true },
      { id: "l2", user_id: "u", google_account_id: "acc-diario", site_id: "fr", is_primary: false },
    ]);
    const box = screen.getByRole("checkbox");
    expect(box).toHaveAttribute("data-state", "checked");
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: /Salvar Mapeamento/ }));
    await waitFor(() => expect(onRemoveLink).toHaveBeenCalledWith("l2"));
    expect(onAddLink).not.toHaveBeenCalled();
  });
});
