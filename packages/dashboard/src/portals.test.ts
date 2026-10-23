import { describe, expect, it } from "vitest";
import { ACCESS_ROLES, capabilitiesOf } from "../../core/src/permissions";
import { landingPortal, machineOfSub, machineSub, portalsFor, PORTALS, stickerOf } from "./portals";

/**
 * Each role sees the right portals (TASK-058) — worked out from the real permission table
 * (core/src/permissions.ts), the one the API sends in /dashboard/me, not from a copy of it.
 */
const seen = (role: string, status = "active") => portalsFor([...capabilitiesOf({ accessRole: role, status })]).map((p) => p.id);

describe("which portals a role sees", () => {
  it("Operations and Analytics are for the people who run the machines; Stock for whoever holds or sees stock; Cash for whoever handles or checks it; Route for whoever plans or goes to the machines; Tasks and Projects for everyone", () => {
    const expected: Record<string, string[]> = {
      ceo: ["tasks", "projects", "operations", "analytics", "inventory", "cash", "route"],
      admin: ["tasks", "projects", "operations", "analytics", "inventory", "cash", "route"],
      ops_head: ["tasks", "projects", "operations", "analytics", "inventory", "cash", "route"],
      supervisor: ["tasks", "projects", "operations", "analytics", "inventory", "cash", "route"],
      manager: ["tasks", "projects"],
      lead: ["tasks", "projects"],
      // The cash auditor checks cash and sees no stock; the warehouse sees no cash.
      cash_auditor: ["tasks", "projects", "cash"],
      warehouse_keeper: ["tasks", "projects", "inventory"],
      technician: ["tasks", "projects", "inventory", "route"],
      vmo: ["tasks", "projects", "inventory", "cash", "route"],
      employee: ["tasks", "projects"],
    };
    expect(Object.keys(expected).sort()).toEqual([...ACCESS_ROLES].sort()); // no role left out
    for (const role of ACCESS_ROLES) expect({ role, portals: seen(role) }).toEqual({ role, portals: expected[role] });
  });

  it("an account that is switched off sees only what needs no permission, and so does one not yet known", () => {
    expect(seen("ceo", "disabled")).toEqual(["tasks", "projects"]);
    expect(portalsFor(undefined).map((p) => p.id)).toEqual(["tasks", "projects"]);
  });

  it("a person lands where they asked if they may, else on the first portal they may open", () => {
    const vmo = [...capabilitiesOf({ accessRole: "vmo", status: "active" })];
    const sup = [...capabilitiesOf({ accessRole: "supervisor", status: "active" })];
    expect(landingPortal("operations", vmo)).toBe("tasks");
    expect(landingPortal("operations", sup)).toBe("operations");
    expect(landingPortal(null, sup)).toBe("tasks");
    // Not known yet: take them where they asked; the shell moves them once it knows.
    expect(landingPortal("operations", undefined)).toBe("operations");
  });

  it("a machine sticker's link names its machine by a UUID token, and nothing else is taken for one", () => {
    expect(stickerOf("#visit/0B6F8A52-3C1D-4E2F-9A7B-1C2D3E4F5A6B")).toBe("0b6f8a52-3c1d-4e2f-9a7b-1c2d3e4f5a6b");
    expect(stickerOf("#visit/793")).toBeNull();
    expect(stickerOf("#visit/0b6f8a52-3c1d-4e2f-9a7b-1c2d3e4f5a6b/extra")).toBeNull();
    expect(stickerOf("#route")).toBeNull();
  });

  it("a machine's page is #operations/machine/<number>, and nothing else is taken for one", () => {
    expect(machineSub(793)).toBe("machine:793");
    expect(machineOfSub("machine:793")).toBe(793);
    expect(machineOfSub("machine:0")).toBeNull();
    expect(machineOfSub("machine:123456")).toBeNull();
    expect(machineOfSub("vends")).toBeNull();
    expect(machineOfSub(null)).toBeNull();
  });

    it("every portal has an id, a label and a place in the picker", () => {
    expect(new Set(PORTALS.map((p) => p.id)).size).toBe(PORTALS.length);
    for (const p of PORTALS) expect(p.points.length).toBeGreaterThan(0);
  });
});
