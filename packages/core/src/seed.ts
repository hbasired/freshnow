import { randomUUID } from "node:crypto";
import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { escalateBlocker, routeBlocker } from "./routing.js";

// Everything here is SYNTHETIC and clearly labelled. Names are DEMO-prefixed and
// every row carries is_synthetic=true, so demo data is never mistaken for real.
// See knowledge-base/assumptions.md — none of this reflects real FreshNow data.
const SEED_CORR = "5eed5eed-5eed-5eed-5eed-5eed5eed5eed";

const EMPLOYEES = [
  { id: "d0000000-0000-0000-0000-000000000001", name: "DEMO – Ahmed Khan", dept: "warehouse", site: "Al Quoz", shift: "day", lang: "en", role: "Warehouse Lead" },
  { id: "d0000000-0000-0000-0000-000000000002", name: "DEMO – Priya Nair", dept: "production", site: "Al Quoz", shift: "day", lang: "en", role: "Production Operator" },
  { id: "d0000000-0000-0000-0000-000000000003", name: "DEMO – Ramesh Singh", dept: "delivery", site: "Deira", shift: "day", lang: "hi", role: "Driver" },
  { id: "d0000000-0000-0000-0000-000000000004", name: "DEMO – Sara Ali", dept: "retail", site: "Dubai Mall", shift: "day", lang: "en", role: "Retail Staff" },
  { id: "d0000000-0000-0000-0000-000000000005", name: "DEMO – Vikram Rao", dept: "production", site: "Al Quoz", shift: "night", lang: "hi", role: "QC Technician" },
] as const;
const IDS = EMPLOYEES.map((e) => e.id);

export interface SeedCounts {
  employees: number;
  tasks: number;
  updates: number;
  blockers: number;
}

/** Idempotent: wipes prior seed rows (by the fixed ids / correlation) then re-inserts. */
export async function seedDemo(): Promise<SeedCounts> {
  const sql = getServiceSql();

  // 1) Reset prior seed (dependents first).
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by in ${sql(IDS)})`;
  await sql`delete from blocker where raised_by in ${sql(IDS)}`;
  await sql`delete from task_update where employee_id in ${sql(IDS)}`;
  await sql`delete from assignment where assigned_to in ${sql(IDS)} or assigned_by in ${sql(IDS)}`;
  await sql`delete from task where employee_id in ${sql(IDS)}`;
  await sql`delete from run_trace where correlation_id = ${SEED_CORR}`;
  await sql`delete from audit_log where correlation_id = ${SEED_CORR}`;
  await sql`delete from notification_outbox where idempotency_key like 'blocker.raised:%' or idempotency_key like 'blocker.escalated:%'`;
  await sql`delete from alert where correlation_id = ${SEED_CORR}`;

  // 2) Upsert employees (all report to the CEO in the demo).
  for (const e of EMPLOYEES) {
    await sql`
      insert into employee (id, display_name, manager_employee_id, department, role_title, site, shift, language, status, is_synthetic)
      values (${e.id}, ${e.name}, ${DEMO_CEO_ID}, ${e.dept}, ${e.role}, ${e.site}, ${e.shift}, ${e.lang}, 'active', true)
      on conflict (id) do update set
        display_name = excluded.display_name, department = excluded.department, role_title = excluded.role_title,
        site = excluded.site, shift = excluded.shift, language = excluded.language, status = 'active', is_synthetic = true`;
  }

  let tasks = 0;
  let updates = 0;
  let blockers = 0;

  async function addTask(empId: string, title: string, status: string): Promise<string> {
    const id = randomUUID();
    await sql`insert into task (id, employee_id, title, status, is_synthetic)
              values (${id}, ${empId}, ${title}, ${status}, true)`;
    tasks++;
    return id;
  }
  async function addUpdate(taskId: string, empId: string, status: string, daysAgo: number, noteRaw?: string, parsed?: unknown): Promise<string> {
    const id = randomUUID();
    await sql`insert into task_update (id, task_id, employee_id, status, note_raw, note_parsed, correlation_id, submitted_at, is_synthetic)
              values (${id}, ${taskId}, ${empId}, ${status}, ${noteRaw ?? null},
                      ${parsed === undefined ? null : sql.json(parsed as never)}, ${SEED_CORR},
                      now() - make_interval(days => ${daysAgo}), true)`;
    updates++;
    return id;
  }
  async function addBlocker(updId: string, empId: string, category: string, severity: string, asset: string, risk: string): Promise<string> {
    const id = randomUUID();
    await sql`insert into blocker (id, task_update_id, raised_by, category, severity, status, affected_asset, risk, correlation_id, is_synthetic)
              values (${id}, ${updId}, ${empId}, ${category}, ${severity}, 'open', ${asset}, ${risk}, ${SEED_CORR}, true)`;
    blockers++;
    return id;
  }

  // Ahmed — warehouse, a normal day
  const t1 = await addTask(IDS[0]!, "Restock Deira metro machines", "done");
  await addUpdate(t1, IDS[0]!, "done", 1);
  const t2 = await addTask(IDS[0]!, "Load van 2 for afternoon route", "pending");
  await addUpdate(t2, IDS[0]!, "pending", 1);

  // Priya — production, high blocker
  const t3 = await addTask(IDS[1]!, "Bottle filling line A run", "pending");
  const u3 = await addUpdate(t3, IDS[1]!, "blocker", 1, "filler head 3 jammed, line stopped", {
    is_blocker: true, category: "equipment", severity: "high", affected_asset: "filler head 3", summary: "Filler head jammed, line stopped",
  });
  const b1 = await addBlocker(u3, IDS[1]!, "equipment", "high", "filler head 3", "production stopped");

  // Ramesh — driver (Hindi), critical cold-chain blocker
  const t4 = await addTask(IDS[2]!, "Morning delivery run Deira", "in_progress");
  const u4 = await addUpdate(t4, IDS[2]!, "blocker", 0, "van 2 ka chiller theek nahi hai, juice kharab ho jayega", {
    is_blocker: true, category: "equipment", severity: "critical", affected_asset: "van 2 chiller", risk: "cold chain / spoilage", summary: "Van 2 chiller failing, cold chain at risk",
  });
  const b2 = await addBlocker(u4, IDS[2]!, "equipment", "critical", "van 2 chiller", "cold chain / spoilage");

  // Sara — retail, done
  const t5 = await addTask(IDS[3]!, "Dubai Mall kiosk opening checks", "done");
  await addUpdate(t5, IDS[3]!, "done", 2);

  // Vikram — QC, older quality blocker (will be escalated)
  const t6 = await addTask(IDS[4]!, "Batch QC — orange juice lot 42", "in_progress");
  const u6 = await addUpdate(t6, IDS[4]!, "blocker", 2, "batch 42 brix out of spec, hold released stock", {
    is_blocker: true, category: "quality", severity: "high", summary: "Batch 42 brix out of spec",
  });
  const b3 = await addBlocker(u6, IDS[4]!, "quality", "high", "lot 42", "out-of-spec product");

  // Route all blockers deterministically (→ CEO), writing audit history.
  for (const b of [b1, b2, b3]) await routeBlocker(b, SEED_CORR);

  // Make one overdue and escalate it (demo escalation history).
  await sql`update blocker set sla_due_at = now() - make_interval(hours => 3) where id = ${b3}`;
  await escalateBlocker(b3, "SLA breach (seed demo)", SEED_CORR);

  // A couple of run_trace rows so replay (Task 015) has history.
  await sql`insert into run_trace (correlation_id, step, input, output) values
    (${SEED_CORR}, 'parse_update', ${sql.json({ text: "van 2 ka chiller theek nahi hai" } as never)}, ${sql.json({ category: "equipment", severity: "critical" } as never)}),
    (${SEED_CORR}, 'route_blocker', ${sql.json({ category: "equipment" } as never)}, ${sql.json({ resolver: "CEO" } as never)})`;

  await logAudit({
    correlationId: SEED_CORR, actor: "seed", action: "demo.seeded",
    detail: { employees: EMPLOYEES.length, tasks, updates, blockers },
  });

  return { employees: EMPLOYEES.length, tasks, updates, blockers };
}
