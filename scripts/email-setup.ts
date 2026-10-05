import "dotenv/config";
import {
  closeDb,
  DEMO_CEO_ID,
  emailAllowlist,
  emailStatus,
  getServiceSql,
  inboxConfig,
  matchPeopleByName,
  setChannelEnabled,
  setEmployeeEmail,
  setNotificationPref,
  type PrefEventType,
} from "../packages/core/src/index.js";

/**
 * `pnpm email:setup` — wire the demo's two email addresses into the system, once.
 *
 * Reads three lines from .env (never from this file — the repository is public):
 *   EMAIL_CEO_ADDRESS        the CEO's address (also the Gmail account the system sends from and reads)
 *   EMAIL_EMPLOYEE_ADDRESS   the one employee's address
 *   EMAIL_EMPLOYEE_NAME      that employee's name as it appears in FreshNow (e.g. Hemanth)
 * and then: stores each address on the right person, switches the email channel on, and opts both
 * people in to the emails that make sense for them. Safe to run again.
 */

const ceoAddress = process.env.EMAIL_CEO_ADDRESS?.trim().toLowerCase();
const empAddress = process.env.EMAIL_EMPLOYEE_ADDRESS?.trim().toLowerCase();
const empName = process.env.EMAIL_EMPLOYEE_NAME?.trim() || "Hemanth";
const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

try {
  if (!ceoAddress || !empAddress) fail("Set EMAIL_CEO_ADDRESS and EMAIL_EMPLOYEE_ADDRESS in .env first (EMAIL-DEMO-GUIDE.md §2).");
  const allow = emailAllowlist();
  if (!allow || !allow.has(ceoAddress!) || !allow.has(empAddress!)) {
    fail(`EMAIL_ALLOWLIST must contain both addresses. Put this line in .env:\n  EMAIL_ALLOWLIST=${ceoAddress},${empAddress}`);
  }

  const sql = getServiceSql();
  const ceo = (await sql<{ id: string; display_name: string }[]>`select id, display_name from employee where id = ${DEMO_CEO_ID}`)[0];
  if (!ceo) fail("The CEO's employee row is missing — run pnpm seed (or check DEMO_CEO_ID).");
  const active = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from employee where status = 'active' and id <> ${DEMO_CEO_ID} order by display_name limit 5000`;
  // The same whole-word name rule the system routes by: exactly one person, or stop and say so.
  const matches = matchPeopleByName(empName, active);
  if (matches.length !== 1) {
    fail(
      matches.length === 0
        ? `Nobody active is called "${empName}". Set EMAIL_EMPLOYEE_NAME to their name as FreshNow shows it.`
        : `"${empName}" fits ${matches.length} people: ${matches.map((m) => m.display_name).join(", ")}. Set EMAIL_EMPLOYEE_NAME to the full name.`,
    );
  }
  const emp = matches[0]!;

  await setEmployeeEmail({ employeeId: ceo!.id, email: ceoAddress!, by: ceo!.id });
  await setEmployeeEmail({ employeeId: emp.id, email: empAddress!, by: ceo!.id });
  console.log(`✓ ${ceo!.display_name} → ${ceoAddress}`);
  console.log(`✓ ${emp.display_name} → ${empAddress}`);

  const s = emailStatus();
  if (s.sending) {
    await setChannelEnabled({ channel: "email", enabled: true, by: ceo!.id });
    console.log("✓ email channel switched on");
  } else {
    console.log("! SMTP_HOST / EMAIL_FROM are not set — addresses stored, but nothing can be sent yet.");
  }

  // What each person is emailed about. They can change it themselves under Alerts → How you are told.
  const optIn = async (id: string, events: PrefEventType[]) => {
    for (const eventType of events) await setNotificationPref({ employeeId: id, eventType, channel: "email", mode: "immediate" });
  };
  await optIn(ceo!.id, ["blocker.raised", "blocker.escalated", "task.done", "project.news"]);
  await optIn(emp.id, ["task.assigned", "blocker.resolved", "project.news"]);
  console.log("✓ email preferences: the CEO hears about problems and finished work; the employee about new tasks");

  const inbox = inboxConfig();
  console.log(
    inbox
      ? `✓ replies are read from ${inbox.inboxAddress} every ${inbox.pollSeconds}s once the worker is running`
      : "! EMAIL_IMAP_* is not set — email goes out, but replies are not read.",
  );
  console.log("\nNext: restart the api, worker and bot. Both people are asked to agree to the updated privacy notice (it now names email) — tap I agree in Telegram or the app.");
} finally {
  await closeDb();
}
