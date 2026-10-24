import { describe, expect, it } from "vitest";
import { ACCESS_ROLES, capabilitiesOf } from "../../core/src/permissions";
import {
  analyticsCategoryOf,
  analyticsCategorySub,
  analyticsMachineOf,
  analyticsMachineSub,
  ANALYTICS_VIEWS,
  decodePart,
  landingPortal,
  machineOfSub,
  machineSub,
  portalsFor,
  PORTALS,
  stickerOf,
} from "./portals";

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

describe("the Analytics portal's pages (TASK-075)", () => {
  it("has an Overview, Categories, Trends and Compare", () => {
    expect([...ANALYTICS_VIEWS]).toEqual(["machines", "categories", "trends", "compare"]);
  });

  it("opens a machine by FreshNow's id or by a Televend record FreshNow has no machine for — nothing else", () => {
    const id = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
    expect(analyticsMachineOf(analyticsMachineSub(id))).toBe(id);
    expect(analyticsMachineOf(analyticsMachineSub(id.toUpperCase()))).toBe(id);
    expect(analyticsMachineOf(analyticsMachineSub("tv:993001"))).toBe("tv:993001");
    for (const bad of ["993001", "tv:", "tv:12a", "<script>", ""]) expect(analyticsMachineOf(analyticsMachineSub(bad))).toBeNull();
    // The Operations machine page's sub is not an Analytics page.
    expect(analyticsMachineOf(machineSub(312))).toBeNull();
    expect(analyticsMachineOf(null)).toBeNull();
  });

  it("opens a category by its name — 1 to 60 characters, spaces tidied, slashes and all", () => {
    expect(analyticsCategoryOf(analyticsCategorySub("Hospital / Clinics"))).toBe("Hospital / Clinics");
    expect(analyticsCategoryOf(analyticsCategorySub("  Metro   stations "))).toBe("Metro stations");
    expect(analyticsCategoryOf(analyticsCategorySub(""))).toBeNull();
    expect(analyticsCategoryOf(analyticsCategorySub("x".repeat(61)))).toBeNull();
    expect(analyticsCategoryOf("am:tv:1")).toBeNull();
    // As the link carries it: encoded, so a "/" in the name never splits the hash.
    const part = encodeURIComponent("Hospital / Clinics");
    expect(part).not.toContain("/");
    expect(decodePart(part)).toBe("Hospital / Clinics");
    expect(decodePart("%E0%A4%A")).toBeNull();
  });
});
