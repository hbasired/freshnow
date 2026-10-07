import "dotenv/config";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "../packages/core/src/index.js";

/**
 * Clear out a demo, so it can be run again from a clean start with the same phones.
 *
 * Two modes:
 *
 *   REMOVE the person entirely — they can then redeem a fresh invite code and you can
 *   show onboarding live:
 *     npx tsx scripts/reset-employee.ts --telegram 8903000291
 *     npx tsx scripts/reset-employee.ts --name "Ahmed Khan"
 *     npx tsx scripts/reset-employee.ts --all-real            every real (non-DEMO) employee
 *
 *   KEEP the person registered, wipe only what they did — for when you have practised
 *   with your own accounts and want a clean board without re-registering:
 *     npx tsx scripts/reset-employee.ts --telegram 8903000291 --activity
 *     npx tsx scripts/reset-employee.ts --ceo --activity      the CEO account
 *     npx tsx scripts/reset-employee.ts --all-real --activity --ceo
 *
 *   Add --dry-run to any of them to see what would happen and change nothing.
 *
 * Safety rails:
 *   • The CEO row can never be deleted — `--ceo` only works with `--activity`.
 *   • DEMO (is_synthetic) staff are kept unless you pass --include-demo, so the
 *     dashboard still has content to show.
 *   • Rows are removed children-first so no foreign key is ever violated. Nothing in this
 *     schema cascades, so the order below is the reason this works at all.
 *   • audit_log is deliberately NOT touched — it is the append-only record of what
 *     happened, and history is not rewritten just because a test was re-run.
 */
const args = process.argv.slice(2);
const has = (f: string): boolean => args.includes(f);
const val = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = has("--dry-run");
const includeDemo = has("--include-demo");
const activityOnly = has("--activity");
const withCeo = has("--ceo");
const sql = getServiceSql();

if (withCeo && !activityOnly) {
  console.error(
    "--ceo deletes nothing: the CEO row must survive for routing and assignment.\n" +
      "Use --ceo --activity to clear what the CEO did during a test.",
  );
  process.exit(1);
}

// ── Work out who this applies to ────────────────────────────────────────────
type Row = { id: string; display_name: string; telegram_user_id: string | null; is_synthetic: boolean };
let targets: Row[];

if (has("--all-real")) {
  targets = [
    ...(await sql<Row[]>`
      select id, display_name, telegram_user_id, is_synthetic from employee
      where id <> ${DEMO_CEO_ID}
        and (${includeDemo} or is_synthetic = false)
      order by display_name`),
  ];
} else if (val("--telegram")) {
  targets = [
    ...(await sql<Row[]>`
      select id, display_name, telegram_user_id, is_synthetic from employee
      where telegram_user_id = ${Number(val("--telegram"))} and id <> ${DEMO_CEO_ID}`),
  ];
} else if (val("--name")) {
  targets = [
    ...(await sql<Row[]>`
      select id, display_name, telegram_user_id, is_synthetic from employee
      where display_name ilike ${val("--name")!} and id <> ${DEMO_CEO_ID}`),
  ];
} else if (withCeo) {
  targets = [];
} else {
  console.error(
    "usage: reset-employee.ts (--all-real | --telegram <id> | --name <name> | --ceo --activity)\n" +
      "                        [--activity] [--include-demo] [--dry-run]",
  );
  process.exit(1);
}

if (withCeo) {
  const ceo = await sql<Row[]>`
    select id, display_name, telegram_user_id, is_synthetic from employee where id = ${DEMO_CEO_ID}`;
  if (ceo[0]) targets.push(ceo[0]);
}

if (targets.length === 0) {
  console.log("Nothing matched — nothing to delete.");
  await closeDb();
  process.exit(0);
}

const verb = activityOnly ? "CLEAR THE ACTIVITY OF" : "DELETE";
console.log(`\n${dryRun ? `WOULD ${verb}` : verb} ${targets.length} employee(s):`);
for (const t of targets) {
  console.log(
    `  • ${t.display_name}  telegram=${t.telegram_user_id ?? "not linked"}` +
      `${t.is_synthetic ? "  [DEMO]" : "  [real]"}${t.id === DEMO_CEO_ID ? "  [CEO — kept, activity only]" : ""}`,
  );
}

if (dryRun) {
  // Say what is actually there, so a dry run is informative rather than a promise.
  for (const t of targets) {
    const [n] = await sql<{ tasks: number; updates: number; blockers: number; assignments: number; reports: number; files: number }[]>`
      select (select count(*) from task where employee_id = ${t.id})::int as tasks,
             (select count(*) from task_update where employee_id = ${t.id})::int as updates,
             (select count(*) from blocker where raised_by = ${t.id})::int as blockers,
             (select count(*) from assignment where assigned_to = ${t.id} or assigned_by = ${t.id})::int as assignments,
             (select count(*) from daily_report where employee_id = ${t.id})::int as reports,
             (select count(*) from attachment where uploaded_by = ${t.id})::int as files`;
    console.log(
      `    ${t.display_name}: ${n!.tasks} tasks, ${n!.updates} updates, ${n!.blockers} blockers, ` +
        `${n!.assignments} assignments, ${n!.reports} end-of-day reports, ${n!.files} files`,
    );
  }
  console.log("\n--dry-run: nothing was changed.");
  await closeDb();
  process.exit(0);
}

// ── Delete, children before parents ─────────────────────────────────────────
for (const t of targets) {
  const id = t.id;
  const tg = t.telegram_user_id;

  if (!activityOnly) {
    // Anything pointing AT this person from elsewhere must be released first.
    await sql`update employee set manager_employee_id = null where manager_employee_id = ${id}`;
    await sql`update routing_rule set resolver_employee_id = ${DEMO_CEO_ID} where resolver_employee_id = ${id}`;
    await sql`update blocker set assigned_resolver = null where assigned_resolver = ${id}`;
    await sql`update escalation set escalated_to = null where escalated_to = ${id}`;
  }

  // Email (TASK-053, TASK-054). Its rows point at tasks, assignments and updates, and a task
  // points back at the email it was given in — so both directions are released before anything
  // is deleted. Before this, resetting anyone with email history failed on a foreign key (G143).
  await sql`update task set source_email_id = null
            where employee_id = ${id}
               or source_email_id in (select id from email_message where employee_id = ${id})`;
  await sql`update email_message set task_id = null, assignment_id = null, task_update_id = null
            where task_id in (select id from task where employee_id = ${id})
               or assignment_id in (select id from assignment where assigned_to = ${id} or assigned_by = ${id})
               or task_update_id in (select id from task_update where employee_id = ${id})`;
  await sql`update email_proposal set decided_by = null where decided_by = ${id}`;
  await sql`delete from email_proposal
            where proposed_by = ${id}
               or email_message_id in (select id from email_message where employee_id = ${id})`;
  await sql`delete from email_message where employee_id = ${id}`;

  // Attachments reference assignments, tasks, updates AND the uploader, and nothing in
  // this schema cascades — so files go first or every delete below hits a foreign key.
  // (The table arrived in migration 0004, after this script was first written.)
  await sql`
    delete from attachment
    where uploaded_by = ${id}
       or assignment_id in (select id from assignment where assigned_to = ${id} or assigned_by = ${id})
       or task_id in (select id from task where employee_id = ${id})
       or task_update_id in (select id from task_update where employee_id = ${id})`;

  // Their own rows, deepest first.
  await sql`delete from escalation where blocker_id in (select id from blocker where raised_by = ${id})`;
  // `escalation.escalated_to` is ON DELETE NO ACTION. Under the seeded org every escalation
  // target is the CEO, whom this script refuses to delete, so this never fired — but with a
  // real org chart, deleting a manager who was ever escalated TO would throw here (the same
  // class as gotcha G69). Anonymise the reference rather than lose the escalation history.
  await sql`update escalation set escalated_to = null where escalated_to = ${id}`;
  // A ladder rung naming this person by id: remove it. (NULL would trip the CHECK that a
  // target of type 'employee' must name someone — a person who is gone is not a target.)
  await sql`delete from escalation_target where target_employee_id = ${id}`;
  await sql`delete from blocker where raised_by = ${id}`;
  await sql`delete from task_update where employee_id = ${id}`;
  await sql`delete from voice_asset where employee_id = ${id}`;
  await sql`delete from assignment where assigned_to = ${id} or assigned_by = ${id}`;
  await sql`delete from task where employee_id = ${id}`;
  await sql`delete from daily_report where employee_id = ${id}`;

  // Their queued/sent Telegram messages and their half-finished conversation, so the bot
  // does not greet them mid-flow from a previous run.
  if (tg != null) {
    await sql`delete from notification_outbox where chat_id = ${Number(tg)}`;
    await sql`delete from bot_session where key like ${"%" + String(tg) + "%"}`;
  }

  if (activityOnly) {
    console.log(`  ✓ cleared ${t.display_name} (still registered)`);
    continue;
  }

  // Consent belongs to the person; it goes when they do. Free any invite tied to them so
  // the code list stays tidy.
  await sql`delete from consent_record where employee_id = ${id}`;
  await sql`delete from invite_code where employee_id = ${id}`;
  await sql`delete from employee where id = ${id}`;
  console.log(`  ✓ removed ${t.display_name}`);
}

// ── Show the clean state ────────────────────────────────────────────────────
const left = await sql<{ display_name: string; telegram_user_id: string | null; is_synthetic: boolean }[]>`
  select display_name, telegram_user_id, is_synthetic from employee order by is_synthetic, display_name`;
console.log("\nEmployees remaining:");
for (const e of left) {
  console.log(`  • ${e.display_name}  telegram=${e.telegram_user_id ?? "-"}${e.is_synthetic ? "  [DEMO]" : "  [real]"}`);
}
console.log("\nNote: audit_log was NOT touched — history is never rewritten.\n");
await closeDb();
