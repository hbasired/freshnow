import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { closeDb, getServiceSql, logAudit } from "../packages/core/src/index.js";

/**
 * Give an employee a dashboard sign-in.
 *
 *   pnpm link:user "<employee name or id>" <email> [password]
 *
 * Creates (or finds) the Supabase Auth user for that email through the Auth admin API and
 * records its id on `employee.auth_user_id` — the one link the API trusts when it maps a
 * verified token to a person. Without a password argument a random one is generated and
 * printed once; prefer that, since an argument lands in shell history.
 *
 * Needs SUPABASE_URL and SUPABASE_SECRET_KEY (the project secret / service-role key). That
 * key can read every table through Supabase's Data API, which is why only this script reads
 * it — the API, bot and worker never do.
 */

interface EmployeeRow {
  id: string;
  display_name: string;
  status: string;
  auth_user_id: string | null;
}

interface AuthUser {
  id: string;
  email?: string;
}

const [, , who, email, givenPassword] = process.argv;
if (!who || !email) {
  console.error('usage: pnpm link:user "<employee name or id>" <email> [password]');
  process.exit(2);
}

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example).");
  process.exit(2);
}

// A new-style secret key (sb_secret_…) goes in `apikey` only; the gateway swaps it for a
// short-lived JWT. A legacy service-role key is itself a JWT and must also be the bearer.
const headers: Record<string, string> = {
  apikey: key,
  "Content-Type": "application/json",
  ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
};

async function findUser(address: string): Promise<AuthUser | null> {
  // The admin list is paged. A company this size fits in one page; the cap keeps a
  // misbehaving server from looping this forever.
  const perPage = 200;
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, { headers });
    if (!r.ok) throw new Error(`listing users failed (${r.status}): ${await r.text()}`);
    const users = ((await r.json()) as { users?: AuthUser[] }).users ?? [];
    const hit = users.find((u) => u.email?.toLowerCase() === address.toLowerCase());
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
}

async function main(): Promise<void> {
  const sql = getServiceSql();
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(who!);
  const matches = byId
    ? await sql<EmployeeRow[]>`
        select id, display_name, status, auth_user_id from employee where id = ${who!}`
    : await sql<EmployeeRow[]>`
        select id, display_name, status, auth_user_id from employee
        where display_name ilike ${"%" + who! + "%"} order by display_name`;

  if (matches.length !== 1) {
    console.error(
      matches.length === 0
        ? `No employee matches "${who}".`
        : `"${who}" matches ${matches.length} employees — use the id:\n` +
            matches.map((m) => `  ${m.id}  ${m.display_name}`).join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  const emp = matches[0]!;
  if (emp.status !== "active") {
    console.error(`${emp.display_name} is ${emp.status}, not active — the API would refuse the sign-in anyway.`);
    process.exitCode = 1;
    return;
  }

  let user = await findUser(email!);
  let password: string | null = null;
  if (!user) {
    password = givenPassword ?? randomBytes(12).toString("base64url");
    const r = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers,
      // Confirmed up front: the CEO is vouching for this address by linking it.
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!r.ok) throw new Error(`creating the user failed (${r.status}): ${await r.text()}`);
    user = (await r.json()) as AuthUser;
  } else if (givenPassword) {
    const r = await fetch(`${url}/auth/v1/admin/users/${user.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ password: givenPassword }),
    });
    if (!r.ok) throw new Error(`setting the password failed (${r.status}): ${await r.text()}`);
    password = givenPassword;
  }

  // One account per employee, one employee per account (a unique index enforces it).
  // Name the holder instead of surfacing a constraint error.
  const holder = await sql<{ display_name: string }[]>`
    select display_name from employee where auth_user_id = ${user.id} and id <> ${emp.id}`;
  if (holder[0]) {
    console.error(`${email} is already linked to ${holder[0].display_name}. Unlink that first.`);
    process.exitCode = 1;
    return;
  }

  await sql`update employee set auth_user_id = ${user.id} where id = ${emp.id}`;
  await logAudit({
    correlationId: randomUUID(),
    actor: "script:link-dashboard-user",
    action: "dashboard_user.linked",
    entity: "employee",
    entityId: emp.id,
    // The auth id is enough to trace the link; the email address stays in Supabase Auth.
    detail: { authUserId: user.id, previousAuthUserId: emp.auth_user_id },
  });

  console.log(`Linked ${emp.display_name} → ${email}`);
  console.log(password ? `Password: ${password}   (shown once)` : "Existing account — password unchanged.");
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
