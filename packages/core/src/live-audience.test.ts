import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeChangeStream, orgChangeCount, subscribeToChanges } from "./changes.js";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { liveAudienceCount, openLiveAudience } from "./live-audience.js";
import { DEMO_CEO_ID } from "./meta.js";
import { loadViewer } from "./org.js";

/**
 * Who hears a change (TASK-058) — against the real (throwaway) Postgres, never mocked: the picture
 * of what a person may see is read under their own row-level security, so these tests are the
 * policies' tests too.
 *
 *   CEO ── SUP (supervisor) ── VMO1, VMO2          PROJECT: VMO1 is a member, SUP2 leads it
 *   CEO ── SUP2 (supervisor) ── VMO3
 *   CEO ── LEAD (lead, department D) ·· EMP (department D)
 *   CEO ── ADM (admin)
 */
const P = {
  SUP: randomUUID(), VMO1: randomUUID(), VMO2: randomUUID(), SUP2: randomUUID(), VMO3: randomUUID(),
  LEAD: randomUUID(), EMP: randomUUID(), ADM: randomUUID(),
};
const PROJECT = randomUUID();
const TAG = `LIVEAUD-${randomUUID().slice(0, 6)}`;
const DEPT = `${TAG}-dept`;
let stop: (() => void) | undefined;

const e = (id: string) => `e:${id}`;
const s = (id: string) => `s:${id}`;
const p = (id: string) => `p:${id}`;

async function until(ok: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}
/** Write, then wait until this process has heard the org change it causes. */
async function orgChange(write: () => Promise<unknown>): Promise<void> {
  const before = orgChangeCount();
  await write();
  await until(() => orgChangeCount() > before);
}

beforeAll(async () => {
  // The audience learns of org changes through the change stream, so this process must listen.
  stop = await subscribeToChanges(() => undefined);
  const heardBefore = orgChangeCount();
  const sql = getServiceSql();
  const person = (id: string, name: string, role: string, manager: string, department: string | null = null) =>
    sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id, department)
        values (${id}, ${`${TAG}-${name}`}, 'active', true, ${role}, ${manager}, ${department})`;
  await person(P.SUP, "SUP", "supervisor", DEMO_CEO_ID);
  await person(P.SUP2, "SUP2", "supervisor", DEMO_CEO_ID);
  await person(P.LEAD, "LEAD", "lead", DEMO_CEO_ID, DEPT);
  await person(P.ADM, "ADM", "admin", DEMO_CEO_ID);
  await person(P.VMO1, "VMO1", "vmo", P.SUP);
  await person(P.VMO2, "VMO2", "vmo", P.SUP);
  await person(P.VMO3, "VMO3", "vmo", P.SUP2);
  await person(P.EMP, "EMP", "employee", DEMO_CEO_ID, DEPT);
  await sql`insert into project (id, name, lead_employee_id) values (${PROJECT}, ${`${TAG} new site`}, ${P.SUP2})`;
  await sql`insert into project_member (project_id, employee_id) values (${PROJECT}, ${P.VMO1})`;
  // Ten org changes above (eight people, a project, a member). Until all have been heard, any
  // picture loaded now would be out of date the moment the next one lands — and, correctly, hear all.
  await until(() => orgChangeCount() >= heardBefore + 10);
});

afterAll(async () => {
  stop?.();
  const sql = getServiceSql();
  const all = Object.values(P);
  await sql`delete from project_member where project_id = ${PROJECT}`;
  await sql`delete from project where id = ${PROJECT}`;
  await sql`update employee set manager_employee_id = null where id = any(${all})`;
  await sql`delete from employee where id = any(${all})`;
  await closeChangeStream();
  await closeDb();
});

describe("what each person hears", () => {
  it("a supervisor: their reports and themself — not other people's", async () => {
    const a = openLiveAudience(P.SUP);
    await a.ready;
    expect(a.hears([e(P.VMO1)])).toBe(true);
    expect(a.hears([e(P.SUP)])).toBe(true);
    expect(a.hears([e(P.VMO3)])).toBe(false);
    expect(a.hears([s(P.SUP)])).toBe(true);
    expect(a.hears([s(P.VMO1)])).toBe(false); // "that person only" means only them
    expect(a.hears([])).toBe(false); // for those who read everything
    expect(a.hears([p(PROJECT)])).toBe(false);
    expect(a.hears([e(P.VMO3), e(P.VMO2)])).toBe(true); // any one subject is enough
    a.close();
  });

  it("a VMO: what concerns them, and the projects they are on", async () => {
    const a = openLiveAudience(P.VMO1);
    await a.ready;
    expect(a.hears([e(P.VMO1)])).toBe(true);
    expect(a.hears([s(P.VMO1)])).toBe(true);
    expect(a.hears([e(P.VMO2)])).toBe(false);
    expect(a.hears([p(PROJECT)])).toBe(true);
    expect(a.hears([p(randomUUID())])).toBe(false);
    a.close();
  });

  it("a department lead: everyone in their department; a project's lead: that project", async () => {
    const lead = openLiveAudience(P.LEAD);
    await lead.ready;
    expect(lead.hears([e(P.EMP)])).toBe(true);
    expect(lead.hears([e(P.VMO1)])).toBe(false);
    lead.close();
    const sup2 = openLiveAudience(P.SUP2);
    await sup2.ready;
    expect(sup2.hears([p(PROJECT)])).toBe(true);
    sup2.close();
  });

  it("Admin and the CEO: everything, including what only those who read everything may see", async () => {
    for (const id of [P.ADM, DEMO_CEO_ID]) {
      const a = openLiveAudience(id);
      await a.ready;
      expect(a.hears([])).toBe(true);
      expect(a.hears([e(P.VMO3)])).toBe(true);
      expect(a.hears([s(P.VMO1)])).toBe(true);
      a.close();
    }
  });

  it("what each person hears about people and projects is exactly what row security shows them", async () => {
    // The audience asks row security about likely rows only (a measured shortcut, G179). This is
    // the check that the shortcut never changes the answer: every person and every project in the
    // database, for every kind of viewer here, against the policies applied to the whole table.
    const sql = getServiceSql();
    const people = (await sql<{ id: string }[]>`select id from employee`).map((r) => r.id);
    const projects = (await sql<{ id: string }[]>`select id from project`).map((r) => r.id);
    for (const id of [P.SUP, P.SUP2, P.LEAD, P.EMP, P.VMO1, P.ADM, DEMO_CEO_ID]) {
      const viewer = (await loadViewer(id))!;
      const shown = await withContext(
        viewer,
        async (tx) => ({
          people: (await tx<{ id: string }[]>`select id from employee`).map((r) => r.id).sort(),
          projects: (await tx<{ id: string }[]>`select id from project`).map((r) => r.id).sort(),
        }),
        { readOnly: true },
      );
      const a = openLiveAudience(id);
      await a.ready;
      expect({ id, people: people.filter((x) => a.hears([e(x)])).sort() }).toEqual({ id, people: shown.people });
      expect({ id, projects: projects.filter((x) => a.hears([p(x)])).sort() }).toEqual({ id, projects: shown.projects });
      a.close();
    }
  });

  it("everyone: 'everyone', an org change, and any key this code does not know yet", async () => {
    const a = openLiveAudience(P.VMO1);
    await a.ready;
    expect(a.hears(["*"])).toBe(true);
    expect(a.hears(["org"])).toBe(true);
    expect(a.hears(["room:42"])).toBe(true);
    a.close();
  });

  it("a capability key: whoever's role holds it, and nobody else (review 2026-10-17, live-updates-media#5)", async () => {
    const sup = openLiveAudience(P.SUP); // supervisor: televend.read, inventory.read
    const vmo = openLiveAudience(P.VMO1); // VMO: inventory.hold only
    const emp = openLiveAudience(P.EMP); // employee: none of them
    await Promise.all([sup.ready, vmo.ready, emp.ready]);
    expect(sup.hears(["c:inventory.read"])).toBe(true);
    expect(sup.hears(["c:televend.read"])).toBe(true);
    expect(vmo.hears(["c:inventory.read"])).toBe(false);
    expect(vmo.hears(["c:inventory.read", s(P.VMO1)])).toBe(true); // their own handover
    expect(emp.hears(["c:televend.read"])).toBe(false);
    // A capability that does not exist is nobody's — it is not "a key this code does not know".
    expect(sup.hears(["c:no.such.thing"])).toBe(false);
    sup.close();
    vmo.close();
    emp.close();
  });
});

describe("when the picture is not known, the doorbell rings", () => {
  it("before the first load has landed, everything is heard", async () => {
    const a = openLiveAudience(P.VMO2);
    expect(a.hears([e(P.VMO3)])).toBe(true); // nothing loaded yet
    await a.ready;
    expect(a.hears([e(P.VMO3)])).toBe(false);
    a.close();
  });

  it("after a change of manager the old supervisor stops hearing that person and the new one starts", async () => {
    const old = openLiveAudience(P.SUP);
    const next = openLiveAudience(P.SUP2);
    await Promise.all([old.ready, next.ready]);
    expect(old.hears([e(P.VMO2)])).toBe(true);
    expect(next.hears([e(P.VMO2)])).toBe(false);

    await orgChange(() => getServiceSql()`update employee set manager_employee_id = ${P.SUP2} where id = ${P.VMO2}`);
    // Out of date until reloaded — so both hear it, the safe direction.
    expect(next.hears([e(P.VMO2)])).toBe(true);
    for (const a of [old, next]) {
      await a.ready; // may be a load that began before the change…
      await a.ready; // …so ask once more; this one is current
    }
    expect(old.hears([e(P.VMO2)])).toBe(false);
    expect(next.hears([e(P.VMO2)])).toBe(true);
    old.close();
    next.close();
  });

  it("a person switched off is no longer active and hears nothing", async () => {
    const a = openLiveAudience(P.VMO3);
    await a.ready;
    expect(a.active).toBe(true);
    await orgChange(() => getServiceSql()`update employee set status = 'disabled' where id = ${P.VMO3}`);
    await a.ready;
    await a.ready;
    expect(a.active).toBe(false);
    expect(a.hears([e(P.VMO3)])).toBe(false);
    a.close();

    const ghost = openLiveAudience(randomUUID()); // nobody by that id
    await ghost.ready;
    expect(ghost.active).toBe(false);
    ghost.close();
  });

  it("a person's streams share one picture, forgotten when the last of them closes", () => {
    const n = liveAudienceCount();
    const a = openLiveAudience(P.EMP);
    const b = openLiveAudience(P.EMP);
    expect(liveAudienceCount()).toBe(n + 1);
    a.close();
    expect(liveAudienceCount()).toBe(n + 1);
    b.close();
    a.close(); // closing twice changes nothing
    expect(liveAudienceCount()).toBe(n);
  });
});
