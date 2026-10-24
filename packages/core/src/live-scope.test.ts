import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeChangeStream, subscribeToChanges, type ChangeEvent, type ChangeScope } from "./changes.js";
import { closeDb, getServiceSql, withContext } from "./db.js";

/**
 * Whom a change concerns (migration 0027) — written against the real (throwaway) Postgres, never
 * mocked. Every watched table is written to once and the scope that arrives is compared with the
 * table's read policy. Test files run one at a time (vitest.config.ts) and NOTIFY is per database,
 * so what arrives here was caused here; every wait still matches on keys only this file creates.
 *
 *   SUP (supervisor) ── VMO          RES — resolves blockers     OUT — unrelated
 */
const P = { SUP: randomUUID(), VMO: randomUUID(), RES: randomUUID(), OUT: randomUUID() };
const PROJECT = randomUUID();
const TAG = `LIVESCOPE-${randomUUID().slice(0, 6)}`;
const heard: Array<{ e: ChangeEvent; scope: ChangeScope }> = [];
let stop: (() => void) | undefined;
let taskId = "";

const e = (id: string) => `e:${id}`;
const s = (id: string) => `s:${id}`;
const p = (id: string) => `p:${id}`;

/** The scope of the first change to `table` (op `op`) heard after `since` that `match` accepts. */
async function scopeOf(table: string, op: string, since: number, match: (scope: ChangeScope) => boolean = () => true): Promise<string[]> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const hit = heard.slice(since).find((h) => h.e.table === table && h.e.op === op && match(h.scope));
    if (hit) return [...hit.scope].sort();
    if (Date.now() > deadline) throw new Error(`no ${op} on ${table} heard; heard: ${JSON.stringify(heard.slice(since).map((h) => [h.e.table, h.e.op, h.scope]))}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const mark = (): number => heard.length;
const has = (key: string) => (scope: ChangeScope) => scope.includes(key);

beforeAll(async () => {
  stop = await subscribeToChanges((ev, scope) => heard.push({ e: ev, scope }));
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role)
            values (${P.SUP}, ${`${TAG}-SUP`}, 'active', true, 'supervisor'),
                   (${P.RES}, ${`${TAG}-RES`}, 'active', true, 'technician'),
                   (${P.OUT}, ${`${TAG}-OUT`}, 'active', true, 'employee')`;
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
            values (${P.VMO}, ${`${TAG}-VMO`}, 'active', true, 'vmo', ${P.SUP})`;
});

afterAll(async () => {
  stop?.();
  const sql = getServiceSql();
  const all = Object.values(P);
  await sql`delete from project_member where project_id = ${PROJECT}`;
  for (const t of ["milestone", "project_requirement", "project_update", "project_issue"]) {
    await sql`delete from ${sql(t)} where project_id = ${PROJECT}`;
  }
  await sql`delete from project where id = ${PROJECT}`;
  await sql`delete from task_watcher where employee_id = any(${all})`;
  await sql`delete from attachment where uploaded_by = any(${all})`;
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by = any(${all}))`;
  await sql`delete from blocker where raised_by = any(${all})`;
  await sql`delete from assignment where assigned_to = any(${all})`;
  await sql`delete from daily_report where employee_id = any(${all})`;
  await sql`delete from alert where alias like ${`${TAG}%`}`;
  await sql`delete from notification_outbox where idempotency_key like ${`${TAG}%`}`;
  await sql`delete from progress_event where task_id in (select id from task where employee_id = any(${all}))`;
  await sql`delete from task_step where task_id in (select id from task where employee_id = any(${all}))`;
  await sql`delete from task_update where employee_id = any(${all})`;
  await sql`delete from task where employee_id = any(${all})`;
  await sql`update employee set manager_employee_id = null where id = any(${all})`;
  await sql`delete from employee where id = any(${all})`;
  await closeChangeStream();
  await closeDb();
});

describe("work: the viewers of the person it belongs to", () => {
  it("a task tells the viewers of its person; moving it tells the viewers of both", async () => {
    const sql = getServiceSql();
    let m = mark();
    const [t] = await sql<{ id: string }[]>`
      insert into task (employee_id, title, status, is_synthetic) values (${P.VMO}, ${`${TAG} refill 793`}, 'open', true) returning id`;
    taskId = t!.id;
    expect(await scopeOf("task", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO)]);

    m = mark();
    await sql`update task set employee_id = ${P.OUT} where id = ${taskId}`;
    expect(await scopeOf("task", "update", m, has(e(P.OUT)))).toEqual([e(P.OUT), e(P.VMO)].sort());
    await sql`update task set employee_id = ${P.VMO} where id = ${taskId}`;
  });

  it("steps, progress, updates, watchers and attachments find the person through the task", async () => {
    const sql = getServiceSql();
    let m = mark();
    await sql`insert into task_step (task_id, title) values (${taskId}, 'open the door')`;
    expect(await scopeOf("task_step", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO)]);

    m = mark();
    await sql`insert into progress_event (task_id, pct, source) values (${taskId}, 40, 'counted')`;
    expect(await scopeOf("progress_event", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO)]);

    m = mark();
    await sql`insert into task_update (task_id, employee_id, status) values (${taskId}, ${P.VMO}, 'in_progress')`;
    expect(await scopeOf("task_update", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO)]);

    // The watcher sees their own watch; the task's people see who watches it.
    m = mark();
    await sql`insert into task_watcher (task_id, employee_id) values (${taskId}, ${P.OUT})`;
    expect(await scopeOf("task_watcher", "insert", m, has(s(P.OUT)))).toEqual([e(P.VMO), s(P.OUT)].sort());

    m = mark();
    await sql`insert into attachment (uploaded_by, file_id, task_id) values (${P.SUP}, ${`${TAG}-file`}, ${taskId})`;
    expect(await scopeOf("attachment", "insert", m, has(e(P.SUP)))).toEqual([e(P.SUP), e(P.VMO)].sort());
  });

  it("a blocker: the raiser's viewers and the resolver themself; an escalation: only those who read everything", async () => {
    const sql = getServiceSql();
    let m = mark();
    const [b] = await sql<{ id: string }[]>`
      insert into blocker (raised_by, assigned_resolver, affected_asset, is_synthetic) values (${P.VMO}, ${P.RES}, ${`${TAG} 793`}, true) returning id`;
    expect(await scopeOf("blocker", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO), s(P.RES)].sort());

    m = mark();
    await sql`insert into escalation (blocker_id) values (${b!.id})`;
    expect(await scopeOf("escalation", "insert", m)).toEqual([]);
  });

  it("an assignment: the assignee's viewers and the assigner themself; a message: its recipient only", async () => {
    const sql = getServiceSql();
    let m = mark();
    await sql`insert into assignment (task_id, assigned_to, assigned_by, note, is_synthetic) values (${taskId}, ${P.VMO}, ${P.SUP}, ${`${TAG} clean 401`}, true)`;
    expect(await scopeOf("assignment", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO), s(P.SUP)].sort());

    m = mark();
    await sql`insert into notification_outbox (idempotency_key, recipient_employee_id, payload) values (${`${TAG}-msg`}, ${P.VMO}, ${sql.json({ text: "x" })})`;
    expect(await scopeOf("notification_outbox", "insert", m, has(s(P.VMO)))).toEqual([s(P.VMO)]);
  });

  it("alerts and daily reports concern the viewers of their person", async () => {
    const sql = getServiceSql();
    let m = mark();
    await sql`insert into alert (alias, kind, entity, entity_id, employee_id) values (${`${TAG}-a`}, 'test', 'task', ${taskId}, ${P.VMO})`;
    expect(await scopeOf("alert", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO)]);

    m = mark();
    await sql`insert into daily_report (employee_id, report_date) values (${P.VMO}, '2026-10-15')`;
    expect(await scopeOf("daily_report", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO)]);
  });
});

describe("people and projects: who may see whom", () => {
  it("a person's own details concern their viewers; their manager, role, department or status concern everyone", async () => {
    const sql = getServiceSql();
    let m = mark();
    await sql`update employee set display_name = ${`${TAG}-VMO renamed`} where id = ${P.VMO}`;
    expect(await scopeOf("employee", "update", m, has(e(P.VMO)))).toEqual([e(P.VMO)]);

    for (const change of [
      sql`update employee set manager_employee_id = ${P.RES} where id = ${P.VMO}`,
      sql`update employee set access_role = 'technician' where id = ${P.VMO}`,
      sql`update employee set department = 'Warehouse' where id = ${P.VMO}`,
      sql`update employee set status = 'disabled' where id = ${P.VMO}`,
    ]) {
      m = mark();
      await change;
      expect(await scopeOf("employee", "update", m, has(e(P.VMO)))).toEqual([e(P.VMO), "org"]);
    }
    await sql`update employee set manager_employee_id = ${P.SUP}, access_role = 'vmo', department = null, status = 'active' where id = ${P.VMO}`;

    m = mark();
    const extra = randomUUID();
    await sql`insert into employee (id, display_name, status, is_synthetic) values (${extra}, ${`${TAG}-new`}, 'pending', true)`;
    expect(await scopeOf("employee", "insert", m)).toEqual(["org"]);
    await sql`delete from employee where id = ${extra}`;
  });

  it("a change to who sees whom for more than 100 people becomes everyone — and still says org (0029)", async () => {
    const sql = getServiceSql();
    await sql`insert into employee (id, display_name, status, is_synthetic)
              select gen_random_uuid(), ${`${TAG}-many-`} || g, 'active', true from generate_series(1, 101) g`;
    const m = mark();
    await sql`update employee set department = 'Warehouse' where display_name like ${`${TAG}-many-%`}`;
    expect(await scopeOf("employee", "update", m, has("*"))).toEqual(["*", "org"]);
    await sql`delete from employee where display_name like ${`${TAG}-many-%`}`;
  });

  it("a project's rows concern the project; its lead, sponsor and members concern everyone", async () => {
    const sql = getServiceSql();
    let m = mark();
    await sql`insert into project (id, name, lead_employee_id) values (${PROJECT}, ${`${TAG} new site`}, ${P.SUP})`;
    expect(await scopeOf("project", "insert", m)).toEqual(["org"]);

    for (const [table, write] of [
      ["milestone", sql`insert into milestone (project_id, name) values (${PROJECT}, 'site survey')`],
      ["project_requirement", sql`insert into project_requirement (project_id, text) values (${PROJECT}, 'power socket')`],
      ["project_update", sql`insert into project_update (project_id, narrative) values (${PROJECT}, 'surveyed')`],
      ["project_issue", sql`insert into project_issue (project_id, title) values (${PROJECT}, 'no socket')`],
    ] as const) {
      m = mark();
      await write;
      expect(await scopeOf(table, "insert", m, has(p(PROJECT)))).toEqual([p(PROJECT)]);
    }

    m = mark();
    await sql`insert into project_member (project_id, employee_id) values (${PROJECT}, ${P.OUT})`;
    expect(await scopeOf("project_member", "insert", m)).toEqual(["org"]);

    m = mark();
    await sql`update project set name = ${`${TAG} renamed`} where id = ${PROJECT}`;
    expect(await scopeOf("project", "update", m, has(p(PROJECT)))).toEqual([p(PROJECT)]);
    m = mark();
    await sql`update project set sponsor_employee_id = ${P.RES} where id = ${PROJECT}`;
    expect(await scopeOf("project", "update", m, has(p(PROJECT)))).toEqual(["org", p(PROJECT)]);
  });
});

describe("the rules every doorbell keeps", () => {
  /** A private table with the same trigger function, so these rules are tested on their own. */
  type Reserved = Awaited<ReturnType<ReturnType<typeof getServiceSql>["reserve"]>>;
  async function withProbe(scopeSql: string, fn: (q: Reserved, table: string) => Promise<void>) {
    const reserved = await getServiceSql().reserve();
    const table = `live_probe_${randomUUID().slice(0, 8)}`;
    try {
      await reserved.unsafe(`create temp table ${table} (id int, employee_id uuid)`);
      await reserved.unsafe(
        `create trigger ${table}_ins after insert on ${table} referencing new table as new_rows
           for each statement execute function public.notify_change('${scopeSql.replace(/'/g, "''")}')`,
      );
      await reserved.unsafe(
        `create trigger ${table}_upd after update on ${table} referencing old table as old_rows new table as new_rows
           for each statement execute function public.notify_change('${scopeSql.replace(/'/g, "''")}')`,
      );
      await fn(reserved, table);
    } finally {
      await reserved.unsafe(`drop table if exists ${table}`).catch(() => undefined);
      reserved.release();
    }
  }

  it("a statement that changed nothing rings no bell", async () => {
    await withProbe("select 'e:' || employee_id from changed", async (q, table) => {
      const m = mark();
      await q.unsafe(`update ${table} set id = 2 where false`);
      await q.unsafe(`insert into ${table} values (1, '${P.VMO}')`); // a marker that does ring
      await scopeOf(table, "insert", m);
      expect(heard.slice(m).filter((h) => h.e.table === table && h.e.op === "update")).toHaveLength(0);
    });
  });

  it("more than 100 subjects become everyone, to stay inside NOTIFY's 8000 bytes", async () => {
    await withProbe("select 'e:' || employee_id from changed", async (q, table) => {
      const m = mark();
      await q.unsafe(`insert into ${table} select g, gen_random_uuid() from generate_series(1, 101) g`);
      expect(await scopeOf(table, "insert", m)).toEqual(["*"]);
      const m2 = mark();
      await q.unsafe(`insert into ${table} select g, gen_random_uuid() from generate_series(1, 100) g`);
      expect((await scopeOf(table, "insert", m2)).length).toBe(100);
    });
  });

  it("a scope that cannot be worked out never blocks the write: everyone is told, and pictures are reloaded", async () => {
    await withProbe("select 'e:' || no_such_column from changed", async (q, table) => {
      const m = mark();
      await q.unsafe(`insert into ${table} values (1, '${P.VMO}')`);
      // "org" too: a scope that failed might have been a change to who sees whom (0029).
      expect(await scopeOf(table, "insert", m)).toEqual(["*", "org"]);
      const [row] = await q.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
      expect(row!.n).toBe(1);
    });
  });

  it("a write made under a person's own row security still rings the bell", async () => {
    // freshnow_app may not EXECUTE notify_change() (so it cannot attach it to anything), yet the
    // triggers fire for its writes: Postgres checks that privilege when a trigger is created.
    const m = mark();
    await withContext({ employeeId: P.VMO, isCeo: false, accessRole: "vmo", department: null }, (tx) =>
      tx`insert into blocker (raised_by, affected_asset, is_synthetic) values (${P.VMO}, ${`${TAG} written as the app role`}, true)`,
    );
    expect(await scopeOf("blocker", "insert", m, has(e(P.VMO)))).toEqual([e(P.VMO)]);
  });

  it("nobody but its owner may execute the trigger function, and every watched table has its three triggers", async () => {
    const sql = getServiceSql();
    const roles = await sql<{ rolname: string }[]>`
      select rolname from pg_roles where rolname in ('freshnow_app', 'anon', 'authenticated', 'service_role')`;
    expect(roles.length).toBeGreaterThan(0);
    for (const { rolname } of roles) {
      const [r] = await sql<{ ok: boolean }[]>`select has_function_privilege(${rolname}, 'public.notify_change()', 'execute') as ok`;
      expect({ rolname, ok: r!.ok }).toEqual({ rolname, ok: false });
    }
    const rows = await sql<{ table: string; n: number }[]>`
      select c.relname as table, count(*)::int as n
        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace ns on ns.oid = c.relnamespace
        join pg_proc f on f.oid = t.tgfoid
       where ns.nspname = 'public' and f.proname = 'notify_change' and not t.tgisinternal
       group by c.relname order by c.relname`;
    // 0027's nineteen, the stock documents and counts (0032), the cash documents and shifts (0035), the
    // route plans, their stops, visits and their proof (0036), and the warehouse documents (0042).
    expect(rows).toHaveLength(28);
    expect(rows.every((r) => r.n === 3)).toBe(true);
  });

  it("a machine's problem also tells everyone who runs the machines (0033)", async () => {
    const sql = getServiceSql();
    const m = mark();
    await sql`insert into blocker (raised_by, assigned_resolver, affected_asset, is_synthetic)
              values ('00000000-0000-0000-0000-0000000000a1', ${P.RES}, ${`${TAG} machine 793`}, true)`;
    expect(await scopeOf("blocker", "insert", m, has(s(P.RES)))).toEqual(["c:televend.read", "e:00000000-0000-0000-0000-0000000000a1", s(P.RES)].sort());
    await sql`delete from blocker where affected_asset = ${`${TAG} machine 793`}`;
  });

  it("a stock document tells whoever sees all stock, who made it, who confirms it, and whose stock it moves; a count, whoever sees all stock (0032)", async () => {
    const sql = getServiceSql();
    const [place] = await sql<{ id: string }[]>`insert into inv_location (kind, employee_id, is_synthetic) values ('person', ${P.VMO}, true) returning id`;
    const doc = randomUUID();
    const count = randomUUID();
    try {
      let m = mark();
      await sql`insert into stock_doc (id, kind, from_location_id, to_location_id, state, created_by, confirm_side, confirm_by, request_hash, is_synthetic)
                values (${doc}, 'handover', '00000000-0000-0000-0000-00000000b001', ${place!.id}, 'waiting', ${P.SUP}, 'person', ${P.VMO}, ${"0".repeat(64)}, true)`;
      expect(await scopeOf("stock_doc", "insert", m, has(s(P.VMO)))).toEqual(["c:inventory.read", s(P.SUP), s(P.VMO)].sort());
      m = mark();
      await sql`insert into count_session (id, location_id, kind, started_by, is_synthetic) values (${count}, '00000000-0000-0000-0000-00000000b001', 'spot', ${P.SUP}, true)`;
      expect(await scopeOf("count_session", "insert", m)).toEqual(["c:inventory.read"]);
    } finally {
      await sql.begin(async (tx) => {
        await tx`select inv_purge_docs(${[doc]}::uuid[])`;
        await tx`set local freshnow.ledger_purge = 'on'`;
        await tx`delete from count_session where id = ${count}`;
        await tx`delete from inv_location where id = ${place!.id}`;
      });
    }
  });

  it("a cash entry tells whoever sees all cash and the person whose shift it is — even when an auditor made it (0035)", async () => {
    const sql = getServiceSql();
    const shift = randomUUID();
    const doc = randomUUID();
    const [machine] = await sql<{ id: string }[]>`insert into machine (asset_no, label, is_synthetic) values (990991, ${`${TAG} cash machine`}, true) returning id`;
    try {
      let m = mark();
      await sql`insert into shift (id, employee_id, business_date, is_synthetic) values (${shift}, ${P.VMO}, current_date, true)`;
      expect(await scopeOf("shift", "insert", m, has(s(P.VMO)))).toEqual(["c:cash.read", s(P.VMO)].sort());
      m = mark();
      // Made by someone else (an auditor's undo is), in the driver's shift: the driver's screen still hears of it.
      await sql`insert into cash_doc (id, kind, shift_id, created_by, machine_id, amount_fils, request_hash, is_synthetic)
                values (${doc}, 'collection', ${shift}, ${P.SUP}, ${machine!.id}, 0, ${"0".repeat(64)}, true)`;
      expect(await scopeOf("cash_doc", "insert", m, has(s(P.VMO)))).toEqual(["c:cash.read", s(P.VMO)].sort());
    } finally {
      await sql`select cash_purge_shifts(${[shift]}::uuid[])`;
      await sql`delete from machine where id = ${machine!.id}`;
    }
  });

  it("the function is its owner's alone, and every security-definer function looks in pg_temp last (0029)", async () => {
    // The test database reproduces Supabase's default grant of EXECUTE to service_role (global setup),
    // so this says what is true live: only the owner holds it.
    const sql = getServiceSql();
    const [f] = await sql<{ acl: string }[]>`
      select array_to_string(p.proacl, ',') as acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'notify_change'`;
    expect(f!.acl.split(",").map((g) => g.split("=")[0])).toEqual(["postgres"]);
    const loose = await sql<{ name: string; config: string | null }[]>`
      select p.proname as name, array_to_string(p.proconfig, ',') as config
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=pg_catalog, public, pg_temp%'`;
    expect(loose).toEqual([]);
  });
});
