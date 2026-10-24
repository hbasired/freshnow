import "dotenv/config";
import { closeDb, DEMO_CEO_ID, forgetMediaOf, getServiceSql } from "../packages/core/src/index.js";

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

  // Routes (TASK-061 part 2): their visits — with their proof and the links to the stock and cash they posted —
  // through 0036's visit_purge, before the stock and cash below (a visit's links name those documents) and before
  // the photos; then their places on team plans, and the plans they made or changed. A plan someone else has
  // visited is part of that person's record: the reset refuses rather than leave their visit pointing at nothing.
  await sql.begin(async (tx) => {
    const visits = (await tx<{ id: string }[]>`select id from visit where employee_id = ${id}`).map((r) => r.id);
    if (visits.length > 0) await tx`select visit_purge(${visits}::uuid[])`;
    const plans = (await tx<{ id: string }[]>`select id from route_plan where created_by = ${id} or updated_by = ${id}`).map((r) => r.id);
    const [visited] = await tx<{ n: number }[]>`
      select count(*)::int as n from visit v join route_stop s on s.id = v.stop_id where s.plan_id = any(${plans}::uuid[])`;
    if (visited!.n > 0) {
      throw new Error(`${t.display_name} made or changed plans that other people's visits (${visited!.n}) carried out — reset those people first.`);
    }
    // The words they wrote on plans that stay (another planner's, or copied from theirs) go with them (0039) — as erasure does,
    // '[erased]', never empty: a 'check' or 'other' stop must keep words, or copying its plan is refused.
    await tx`update route_plan set note = '[erased]', note_by = null where note_by = ${id}`;
    await tx`update route_stop set instructions = '[erased]', instructions_by = null where instructions_by = ${id}`;
    await tx`delete from route_plan_member where employee_id = ${id} or plan_id = any(${plans}::uuid[])`;
    await tx`delete from route_stop where plan_id = any(${plans}::uuid[])`;
    await tx`update route_plan set copied_from = null where copied_from = any(${plans}::uuid[])`;
    await tx`delete from route_plan where id = any(${plans}::uuid[])`;
  });

  // A machine category they corrected (TASK-070) keeps the correction; who made it, and why in their words, go with them
  // (review, 20 Oct: the words stayed with no author, out of reach of erasure and the download).
  await sql`update machine set category_note = null, category_set_by = null where category_set_by = ${id}`;

  // Stock (TASK-060): the documents they made, confirmed, settled or that moved their stock, through the
  // ledger's one purge (0032's inv_purge_docs — balances rebuilt from what remains), with the counts they
  // took part in and any adjustment those counts posted. A practice run's stock goes; if removing it would
  // leave a real place below zero — a delivery whose cartons went to someone who stays — the purge
  // refuses and says so, rather than leave the books wrong. Before the photos: a document's links go with it.
  await sql.begin(async (tx) => {
    const sessions = (
      await tx<{ id: string }[]>`
        select id from count_session
         where started_by = ${id} or recount_by = ${id} or decided_by = ${id} or recount_waived_by = ${id}`
    ).map((r) => r.id);
    const docs = (
      await tx<{ id: string }[]>`
        select d.id from stock_doc d
          left join inv_location lf on lf.id = d.from_location_id
          left join inv_location lt on lt.id = d.to_location_id
         where d.created_by = ${id} or d.confirm_by = ${id} or d.answered_by = ${id} or d.settled_by = ${id}
            or lf.employee_id = ${id} or lt.employee_id = ${id} or d.count_session_id = any(${sessions}::uuid[])`
    ).map((r) => r.id);
    // Warehouse documents (TASK-086) they made or moved on, with what those posted — in the same one purge (0042's
    // wh_purge_orders takes these stock documents too, so the balances are rebuilt once from what remains).
    const orders = (
      await tx<{ id: string }[]>`
        select id from wh_order where created_by = ${id} or ready_by = ${id} or done_by = ${id} or cancelled_by = ${id}`
    ).map((r) => r.id);
    if (orders.length > 0 || docs.length > 0) await tx`select wh_purge_orders(${orders}::uuid[], ${docs}::uuid[])`;
    await tx`set local freshnow.ledger_purge = 'on'`;
    await tx`delete from count_line where session_id = any(${sessions}::uuid[])`;
    await tx`delete from count_session where id = any(${sessions}::uuid[])`;
    await tx`delete from stock_balance where location_id in (select id from inv_location where employee_id = ${id})`;
    await tx`delete from reorder_rule where location_id in (select id from inv_location where employee_id = ${id})`;
    await tx`delete from inv_location where employee_id = ${id}`;
    await tx`update inv_item set created_by = null where created_by = ${id}`;
    await tx`update supplier set created_by = null where created_by = ${id}`;
    await tx`update reorder_rule set created_by = null where created_by = ${id}`;
    await tx`update reorder_rule set updated_by = null where updated_by = ${id}`;
  });

  // Cash (TASK-061): their shifts with every entry in them, through the ledger's purge (0035's
  // cash_purge_shifts — every balance rebuilt from what remains); the checks they made of other people's
  // shifts are taken back (those shifts stay, unchecked). An undo they made in someone else's shift is part
  // of that person's record: the reset refuses rather than leave it pointing at nobody.
  await sql.begin(async (tx) => {
    const [elsewhere] = await tx<{ n: number }[]>`
      select count(*)::int as n from cash_doc d join shift s on s.id = d.shift_id where d.created_by = ${id} and s.employee_id <> ${id}`;
    if (elsewhere!.n > 0) {
      throw new Error(`${t.display_name} undid ${elsewhere!.n} cash entr${elsewhere!.n === 1 ? "y" : "ies"} in other people's shifts — reset those people first.`);
    }
    const shifts = (await tx<{ id: string }[]>`select id from shift where employee_id = ${id}`).map((r) => r.id);
    if (shifts.length > 0) await tx`select cash_purge_shifts(${shifts}::uuid[])`;
    await tx`update shift set audit_outcome = null, audited_by = null, audited_at = null, audit_note = null where audited_by = ${id}`;
    await tx`update shift set ended_by = null where ended_by = ${id}`;
    await tx`delete from cash_account where employee_id = ${id}`;
  });

  // Photos and videos (TASK-058): their own files — bytes, then records — and every link onto their
  // tasks. Before tasks go, because the links name tasks; and the records name the person.
  await forgetMediaOf(id);

  // Phone sign-in (TASK-058): their sessions in either mode; their set-up, the codes they were given or
  // gave, and their personal phones when they go. Children first — nothing here cascades either.
  await sql`delete from app_session where employee_id = ${id}`;
  if (!activityOnly) {
    const own = sql`select id from device where bound_employee_id = ${id}`;
    await sql`delete from app_session where device_id in (${own}) or credential_id in (select id from app_credential where employee_id = ${id})`;
    await sql`update app_credential set setup_code_id = null
              where setup_code_id in (select id from app_setup_code where employee_id = ${id} or created_by = ${id})`;
    await sql`update app_credential set revoked_by = null where revoked_by = ${id}`;
    await sql`delete from app_credential where employee_id = ${id} or device_id in (${own})`;
    await sql`delete from app_setup_code where employee_id = ${id} or created_by = ${id} or used_on_device in (${own})`;
    await sql`update device set enrolled_by = null where enrolled_by = ${id}`;
    await sql`update device set revoked_by = null where revoked_by = ${id}`;
    await sql`delete from device_enrolment where bound_employee_id = ${id} or created_by = ${id} or device_id in (${own})`;
    await sql`delete from device where bound_employee_id = ${id}`;
  }

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
