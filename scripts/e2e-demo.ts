import "dotenv/config";
import {
  assignTask,
  attachNoteAndProcess,
  closeDb,
  createInvite,
  createTask,
  DEMO_CEO_ID,
  ensureCeoLinked,
  getServiceSql,
  listOpenBlockers,
  listOpenTasks,
  recordTaskUpdate,
  redeemInvite,
  replayRun,
  updateProfileField,
  validateInvite,
} from "../packages/core/src/index.js";

// End-to-end demo run against the REAL demo database, the REAL Groq parser, and the
// REAL running worker (which delivers the outbox to actual Telegram accounts).
// Nothing here is mocked. Pass --keep to leave the employee linked afterwards.
const CEO_TG = Number(process.env.CEO_TELEGRAM_USER_ID ?? 0);
const EMPLOYEE_TG = Number(process.env.E2E_EMPLOYEE_TELEGRAM_ID ?? 0);
const KEEP = process.argv.includes("--keep");

if (!CEO_TG || !EMPLOYEE_TG) {
  throw new Error("CEO_TELEGRAM_USER_ID and E2E_EMPLOYEE_TELEGRAM_ID must be set");
}

const sql = getServiceSql();
let step = 0;
const results: { step: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string): void {
  step += 1;
  results.push({ step: `${step}. ${name}`, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${step}. ${name} — ${detail}`);
}

/** Poll until the outbox row for `key` is delivered by the running worker. */
async function waitForDelivery(key: string, timeoutMs = 30_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const rows = await sql<{ status: string; attempts: number }[]>`
      select status, attempts from notification_outbox where idempotency_key = ${key}`;
    const row = rows[0];
    if (!row) return "missing";
    if (row.status === "sent") return "sent";
    if (row.status === "abandoned") return `abandoned after ${row.attempts} attempts`;
    if (Date.now() - started > timeoutMs) {
      return `timeout in status=${row.status} after ${row.attempts} attempt(s)`;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

console.log("\n=== FreshNow end-to-end demo run ===");
console.log(`CEO Telegram id: ${CEO_TG}   Employee Telegram id: ${EMPLOYEE_TG}\n`);

// ── 0. Reset any previous E2E run so this is repeatable ─────────────────────
const prior = await sql<{ id: string }[]>`
  select id from employee where telegram_user_id = ${EMPLOYEE_TG}`;
for (const p of prior) {
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by = ${p.id})`;
  await sql`delete from blocker where raised_by = ${p.id}`;
  await sql`delete from task_update where employee_id = ${p.id}`;
  await sql`delete from assignment where assigned_to = ${p.id}`;
  await sql`delete from task where employee_id = ${p.id}`;
  await sql`delete from consent_record where employee_id = ${p.id}`;
  await sql`update invite_code set employee_id = null where employee_id = ${p.id}`;
  await sql`delete from employee where id = ${p.id}`;
}
console.log(`Reset: removed ${prior.length} prior E2E employee record(s)\n`);

// ── 1. CEO is linked so alerts have somewhere to land ───────────────────────
await ensureCeoLinked(CEO_TG);
const ceoRow = await sql<{ telegram_user_id: string | null }[]>`
  select telegram_user_id from employee where id = ${DEMO_CEO_ID}`;
check("CEO linked to Telegram", Number(ceoRow[0]?.telegram_user_id) === CEO_TG, `chat ${ceoRow[0]?.telegram_user_id}`);

// ── 2. CEO issues an invite (types a NAME only) ─────────────────────────────
const invite = await createInvite({ displayName: "Ahmed Khan", issuedBy: DEMO_CEO_ID });
check("CEO created invite code", invite.code.length === 8, `code ${invite.code}`);

// ── 3. Checking the code must NOT consume it (consent comes first) ──────────
const pre = await validateInvite(invite.code);
const stillUnused = await sql`select redeemed_at from invite_code where code = ${invite.code}`;
check(
  "Code validates without being consumed",
  pre.valid && pre.displayName === "Ahmed Khan" && stillUnused[0]?.redeemed_at === null,
  `valid=${pre.valid}, name=${pre.displayName}, redeemed=${stillUnused[0]?.redeemed_at}`,
);

// ── 4. Employee redeems + consents (one transaction) ────────────────────────
const redeemed = await redeemInvite(invite.code, EMPLOYEE_TG, "en");
check("Employee redeemed invite", redeemed.ok, `employeeId=${redeemed.employeeId}`);
const employeeId = redeemed.employeeId!;

const consent = await sql<{ policy_version: string; notice_hash: string }[]>`
  select policy_version, notice_hash from consent_record where employee_id = ${employeeId}`;
check("PDPL consent recorded with notice hash", consent.length === 1, `v=${consent[0]?.policy_version} hash=${consent[0]?.notice_hash?.slice(0, 12)}…`);

const empRow = await sql<{ is_synthetic: boolean; telegram_user_id: string }[]>`
  select is_synthetic, telegram_user_id from employee where id = ${employeeId}`;
check("Real person is NOT flagged synthetic", empRow[0]?.is_synthetic === false, `is_synthetic=${empRow[0]?.is_synthetic}`);

// ── 5. Second redeem of the same code must fail ─────────────────────────────
const replay2 = await redeemInvite(invite.code, 9_999_000_111);
check("Same code cannot be redeemed twice", replay2.ok === false, `reason=${replay2.reason}`);

// ── 6. Employee self-fills their profile ────────────────────────────────────
await updateProfileField(employeeId, "department", "production");
await updateProfileField(employeeId, "role_title", "juice production operator");
await updateProfileField(employeeId, "site", "warehouse");
await updateProfileField(employeeId, "shift", "day");
const prof = await sql<{ department: string; role_title: string; site: string; shift: string }[]>`
  select department, role_title, site, shift from employee where id = ${employeeId}`;
check(
  "Employee self-filled profile",
  prof[0]?.department === "production" && prof[0]?.shift === "day",
  `${prof[0]?.role_title} @ ${prof[0]?.site} (${prof[0]?.shift})`,
);

// ── 7. Employee adds a task and it appears in their list ────────────────────
const taskId = await createTask(employeeId, "Restock Deira metro machines");
const myTasks = await listOpenTasks(employeeId);
check("Task created and listed", myTasks.some((t) => t.id === taskId), `${myTasks.length} open task(s)`);

// ── 8. Employee taps [Blocker] — status recorded BEFORE any text or LLM ─────
const rec = await recordTaskUpdate({ taskId, employeeId, status: "blocker" });
const rawFirst = await sql<{ status: string; note_raw: string | null }[]>`
  select status, note_raw from task_update where id = ${rec.taskUpdateId}`;
check(
  "Blocker tap recorded raw-first (no note yet)",
  rawFirst[0]?.status === "blocker" && rawFirst[0]?.note_raw === null,
  `status=${rawFirst[0]?.status}, note_raw=${rawFirst[0]?.note_raw}`,
);

// ── 9. Employee's own words → real Groq parse → deterministic route → alert ─
// Deliberately messy, low-literacy Hinglish, the way a real worker would type it.
const messy = "van 2 ka chiller thanda nahi ho raha juice kharab ho jayega jaldi dekho";
console.log(`\n  (parsing employee text with real Groq: "${messy}")`);
const processed = await attachNoteAndProcess(rec.taskUpdateId, messy, rec.correlationId);
check(
  "Messy Hinglish parsed into a structured blocker",
  !processed.needsReview && !!processed.blockerId,
  `category=${processed.category} severity=${processed.severity} summary="${processed.summary}"`,
);

const stored = await sql<{ note_raw: string }[]>`
  select note_raw from task_update where id = ${rec.taskUpdateId}`;
check("Employee's exact words preserved verbatim", stored[0]?.note_raw === messy, "note_raw matches input");

// ── 10. Routing is deterministic and points at the CEO ──────────────────────
const blk = await sql<{ assigned_resolver: string; sla_due_at: Date; severity: string }[]>`
  select assigned_resolver, sla_due_at, severity from blocker where id = ${processed.blockerId!}`;
check(
  "Blocker routed to the CEO with an SLA",
  blk[0]?.assigned_resolver === DEMO_CEO_ID,
  `resolver=CEO, severity=${blk[0]?.severity}, sla_due=${blk[0]?.sla_due_at?.toISOString()}`,
);

// ── 11. The running worker delivers the alert to the CEO's real Telegram ────
console.log("\n  (waiting for the running worker to deliver the CEO alert…)");
const alertKey = `blocker-alert-${processed.blockerId}`;
const alertStatus = await waitForDelivery(alertKey);
check("CEO alert DELIVERED to real Telegram", alertStatus === "sent", `outbox status=${alertStatus}`);

// ── 12. CEO assigns work back to the employee ───────────────────────────────
const assigned = await assignTask({
  assignedBy: DEMO_CEO_ID,
  assignedTo: employeeId,
  title: "Swap the van 2 chiller unit",
  note: "Do this before the afternoon route.",
});
console.log("  (waiting for the assignment to reach the employee…)");
const assignStatus = await waitForDelivery(`assignment-${assigned.assignmentId}`);
check("Assignment DELIVERED to employee's real Telegram", assignStatus === "sent", `outbox status=${assignStatus}`);

const empTasks = await listOpenTasks(employeeId);
check(
  "Assigned task appears in the employee's task list (loop closed)",
  empTasks.some((t) => t.id === assigned.taskId),
  `${empTasks.length} open task(s)`,
);

// ── 13. CEO's blocker queue shows it ────────────────────────────────────────
const queue = await listOpenBlockers(50);
check(
  "Blocker appears in the CEO's queue",
  queue.some((b) => b.id === processed.blockerId),
  `${queue.length} open blocker(s)`,
);

// ── 14. The run replays to the same decision ────────────────────────────────
const report = await replayRun(rec.correlationId);
check(
  "Run replays deterministically (no divergence)",
  report.checks.length > 0 && !report.diverged,
  `${report.checks.length} routing check(s) re-derived, diverged=${report.diverged}`,
);

// ── 15. Audit trail ties the whole run together ─────────────────────────────
const audit = await sql<{ action: string }[]>`
  select action from audit_log where correlation_id = ${rec.correlationId} order by created_at`;
check(
  "Audit trail complete under one correlation_id",
  audit.length >= 3,
  audit.map((a) => a.action).join(" → "),
);

// ── Cleanup so the live phone walkthrough starts fresh ──────────────────────
if (!KEEP) {
  await sql`update employee set telegram_user_id = null, status = 'pending' where id = ${employeeId}`;
  const fresh = await createInvite({ displayName: "Ahmed Khan", issuedBy: DEMO_CEO_ID });
  console.log(`\nEmployee UNLINKED so you can run the live walkthrough on the phone.`);
  console.log(`Fresh invite code for the live demo:  ${fresh.code}`);
} else {
  console.log(`\nEmployee left LINKED (--keep).`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n=== RESULT: ${results.length - failed.length}/${results.length} checks passed ===`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
}
await closeDb();
process.exit(failed.length === 0 ? 0 : 1);
