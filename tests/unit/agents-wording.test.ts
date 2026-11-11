import { operationLabel } from "@/ui/dashboard/AgentsView";

describe("agent activity log wording", () => {
  it("turns API operation names into words", () => {
    expect(operationLabel("createRule")).toBe("Create rule");
    expect(operationLabel("requestActivation")).toBe("Request activation");
    expect(operationLabel("listTabs")).toBe("List tabs");
    expect(operationLabel("pair")).toBe("Ask to connect");
  });
});
