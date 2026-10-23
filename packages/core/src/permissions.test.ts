import { describe, expect, it } from "vitest";
import {
  ACCESS_ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  ROLE_INFO,
  can,
  capabilitiesOf,
  grantableRoles,
  mayGiveWork,
  mayLeadPeople,
  maySeeOthersBlockers,
  roleChangeRefusal,
} from "./permissions.js";

/**
 * The permission table's rules, checked as rules — not read back from the table. Each test states a
 * decision (SPEC-000 R27/R30, the approved plan §3, the user's answers of 2026-10-15) and fails if
 * an edit to the table breaks it.
 */
describe("the permission table keeps its promises", () => {
  it("lets the CEO do everything, and nobody else make Admins", () => {
    for (const c of CAPABILITIES) expect(can({ isCeo: true }, c), c).toBe(true);
    for (const r of ACCESS_ROLES.filter((x) => x !== "ceo")) expect(can({ accessRole: r }, "people.grant_admin"), r).toBe(false);
  });

  it("gives Admin everything the CEO has except making Admins", () => {
    expect(CAPABILITIES.filter((c) => !can({ accessRole: "admin" }, c))).toEqual(["people.grant_admin"]);
  });

  it("asks questions of the data only for roles that already see everything", () => {
    // The question box runs model-written SQL under the asker's row-level security. A crafted
    // identifier might slip a context change past the query guard (role map, 2026-10-15, not
    // verified) — harmless only if the asker could already read everything.
    for (const r of ACCESS_ROLES) {
      if (can({ accessRole: r }, "data.ask")) expect(can({ accessRole: r }, "data.read_all"), r).toBe(true);
    }
  });

  it("lets Ops Head and Supervisor lead people like a manager; the field roles act on their own work", () => {
    for (const r of ["ops_head", "supervisor", "manager", "lead"] as const) {
      expect(mayGiveWork({ accessRole: r }), r).toBe(true);
      expect(can({ accessRole: r }, "work.give_to_anyone"), r).toBe(false);
      expect(mayLeadPeople(r), r).toBe(true);
      expect(maySeeOthersBlockers({ accessRole: r }), r).toBe(true);
    }
    // The field roles see nobody else's work and give none; what they may do is their own stock
    // (TASK-060) — and the keeper the warehouse's.
    for (const r of ["cash_auditor", "warehouse_keeper", "technician", "vmo", "employee"] as const) {
      expect([...capabilitiesOf({ accessRole: r })].filter((c) => !c.startsWith("inventory.") && !c.startsWith("cash.") && c !== "visits.record"), r).toEqual([]);
      expect(mayGiveWork({ accessRole: r }), r).toBe(false);
      expect(mayLeadPeople(r), r).toBe(false);
    }
    expect(can({ accessRole: "admin" }, "work.give_to_anyone")).toBe(true);
  });

  it("shows the machines and Televend data to the operations leaders only", () => {
    expect(ACCESS_ROLES.filter((r) => can({ accessRole: r }, "televend.read"))).toEqual(["ceo", "admin", "ops_head", "supervisor"]);
  });

  it("splits stock as decided: the keeper runs the warehouse, the Ops Head approves, the field holds (D218)", () => {
    const holders = (c: Parameters<typeof can>[1]) => ACCESS_ROLES.filter((r) => can({ accessRole: r }, c));
    expect(holders("inventory.read")).toEqual(["ceo", "admin", "ops_head", "supervisor", "warehouse_keeper"]);
    expect(holders("inventory.hold")).toEqual(["ceo", "admin", "ops_head", "supervisor", "warehouse_keeper", "technician", "vmo"]);
    expect(holders("inventory.move")).toEqual(["ceo", "admin", "ops_head", "warehouse_keeper"]);
    // The person who counts never decides the difference: the keeper has no approval.
    expect(holders("inventory.approve")).toEqual(["ceo", "admin", "ops_head"]);
    // Cash is not stock: the cash auditor sees none of it.
    expect([...capabilitiesOf({ accessRole: "cash_auditor" })].filter((c) => c.startsWith("inventory."))).toEqual([]);
  });

  it("splits cash as decided: drivers handle it, the auditor and the Ops Head check it, the warehouse never sees it (TASK-061)", () => {
    const holders = (c: Parameters<typeof can>[1]) => ACCESS_ROLES.filter((r) => can({ accessRole: r }, c));
    expect(holders("cash.hold")).toEqual(["ceo", "admin", "ops_head", "supervisor", "vmo"]);
    expect(holders("cash.read")).toEqual(["ceo", "admin", "ops_head", "cash_auditor"]);
    expect(holders("cash.audit")).toEqual(["ceo", "admin", "ops_head", "cash_auditor"]);
    for (const r of ["warehouse_keeper", "technician"] as const) {
      expect([...capabilitiesOf({ accessRole: r })].filter((c) => c.startsWith("cash.")), r).toEqual([]);
    }
  });

  it("splits routes as decided: the Supervisor and the Ops Head plan, whoever goes to the machines visits (TASK-061 part 2)", () => {
    const holders = (c: Parameters<typeof can>[1]) => ACCESS_ROLES.filter((r) => can({ accessRole: r }, c));
    expect(holders("routes.plan")).toEqual(["ceo", "admin", "ops_head", "supervisor"]);
    expect(holders("visits.record")).toEqual(["ceo", "admin", "ops_head", "supervisor", "technician", "vmo"]);
    // The warehouse and the cash auditor do not go to the machines.
    for (const r of ["warehouse_keeper", "cash_auditor"] as const) expect(can({ accessRole: r }, "visits.record"), r).toBe(false);
  });

  it("lets only the Ops Head, the CEO and an Admin correct a machine's category (TASK-070, D248)", () => {
    const holders = (c: Parameters<typeof can>[1]) => ACCESS_ROLES.filter((r) => can({ accessRole: r }, c));
    expect(holders("machines.manage")).toEqual(["ceo", "admin", "ops_head"]);
  });

  it("refuses everything to an account that is not active, and to a role it does not know", () => {
    expect([...capabilitiesOf({ accessRole: "admin", status: "disabled" })]).toEqual([]);
    expect([...capabilitiesOf({ isCeo: true, status: "pending" })]).toEqual([]);
    expect([...capabilitiesOf({ accessRole: "superuser" })]).toEqual([]);
    expect([...capabilitiesOf({})]).toEqual([]);
  });

  it("never offers the CEO role, and offers Admin only to the CEO", () => {
    expect(grantableRoles({ isCeo: true })).toEqual(ACCESS_ROLES.filter((r) => r !== "ceo"));
    expect(grantableRoles({ accessRole: "admin" })).toEqual(ACCESS_ROLES.filter((r) => r !== "ceo" && r !== "admin"));
    expect(grantableRoles({ accessRole: "manager" })).toEqual([]);
  });

  it("refuses the role changes the CEO keeps for themselves", () => {
    const admin = { accessRole: "admin" };
    expect(roleChangeRefusal(admin, "employee", "vmo")).toBeNull();
    expect(roleChangeRefusal(admin, "ceo", "employee")).toMatch(/CEO/);
    expect(roleChangeRefusal(admin, "employee", "ceo")).toMatch(/CEO/);
    expect(roleChangeRefusal(admin, "employee", "admin")).toMatch(/Only the CEO/);
    expect(roleChangeRefusal(admin, "admin", "employee")).toMatch(/Only the CEO/);
    expect(roleChangeRefusal({ isCeo: true }, "employee", "admin")).toBeNull();
    // The CEO hands the CEO role over (through the API; the People page never offers it).
    expect(roleChangeRefusal({ isCeo: true }, "employee", "ceo")).toBeNull();
    expect(roleChangeRefusal({ isCeo: true }, "ceo", "employee")).toBeNull();
    expect(roleChangeRefusal({ accessRole: "ops_head" }, "employee", "vmo")).toMatch(/Only the CEO or an Admin/);
    expect(roleChangeRefusal({ isCeo: true }, "employee", "boss")).toMatch(/not a role/);
  });

  it("has a label and a plain description for every role, and no way to rank or score people (R27)", () => {
    for (const r of ACCESS_ROLES) {
      expect(ROLE_INFO[r].label.length, r).toBeGreaterThan(0);
      expect(ROLE_INFO[r].describe.length, r).toBeGreaterThan(10);
    }
    for (const c of CAPABILITIES) expect(c).not.toMatch(/rank|score|leaderboard|productivity/i);
    for (const r of ACCESS_ROLES) for (const c of ROLE_CAPABILITIES[r]) expect(CAPABILITIES).toContain(c);
  });
});
