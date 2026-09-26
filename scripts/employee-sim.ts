import "dotenv/config";
import {
  attachNoteAndProcess,
  closeDb,
  createTask,
  DEMO_CEO_ID,
  getServiceSql,
  recordTaskUpdate,
} from "../packages/core/src/index.js";

/**
 * Drive ONE employee status report through the real pipeline and print what the
 * system made of it. Used to stress the parser with realistic low-literacy input.
 *
 *   npx tsx scripts/employee-sim.ts "chiller kharab hai"
 *
 * Safety: any alert this produces is marked `abandoned` immediately so the CEO's
 * real phone is not spammed by test runs. All rows are is_synthetic.
 */
const text = process.argv.slice(2).join(" ").trim();
if (!text) throw new Error('usage: tsx scripts/employee-sim.ts "the employee message"');

const sql = getServiceSql();

// A dedicated synthetic tester, kept separate from the real demo accounts.
const existing = await sql<{ id: string }[]>`
  select id from employee where display_name = 'SIM - low literacy tester'`;
const employeeId =
  existing[0]?.id ??
  (
    await sql<{ id: string }[]>`
      insert into employee (display_name, department, site, shift, language, status, is_synthetic)
      values ('SIM - low literacy tester', 'warehouse', 'warehouse', 'day', 'hi', 'active', true)
      returning id`
  )[0]!.id;

const taskId = await createTask(employeeId, "Daily shift work", true);
const rec = await recordTaskUpdate({ taskId, employeeId, status: "blocker" });

let out: Record<string, unknown>;
try {
  const processed = await attachNoteAndProcess(rec.taskUpdateId, text, rec.correlationId);

  let resolver: string | null = null;
  let severity: string | null = null;
  if (processed.blockerId) {
    const b = await sql<{ assigned_resolver: string | null; severity: string | null }[]>`
      select assigned_resolver, severity from blocker where id = ${processed.blockerId}`;
    resolver = b[0]?.assigned_resolver ?? null;
    severity = b[0]?.severity ?? null;
  }

  // Do not deliver simulated alerts to the real CEO phone.
  await sql`update notification_outbox set status = 'abandoned'
            where idempotency_key = ${`blocker-alert-${processed.blockerId}`} and status = 'pending'`;

  const stored = await sql<{ note_raw: string | null }[]>`
    select note_raw from task_update where id = ${rec.taskUpdateId}`;

  out = {
    input: text,
    raw_text_preserved: stored[0]?.note_raw === text,
    needs_review: processed.needsReview,
    created_blocker: !!processed.blockerId,
    category: processed.category ?? null,
    severity,
    summary: processed.summary ?? null,
    routed_to_ceo: resolver === DEMO_CEO_ID,
    crashed: false,
  };
} catch (err) {
  const stored = await sql<{ note_raw: string | null }[]>`
    select note_raw from task_update where id = ${rec.taskUpdateId}`;
  out = {
    input: text,
    raw_text_preserved: stored[0]?.note_raw === text,
    crashed: true,
    error: err instanceof Error ? err.message : String(err),
  };
}

console.log(JSON.stringify(out, null, 2));
await closeDb();
