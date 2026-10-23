import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const r = await sql`select (select count(*) from employee)::int employees, (select count(*) from task)::int tasks,
  (select count(*) from tv_vend)::int vends, (select count(*) from audit_log)::int audit, (select count(*) from role_capability)::int caps`;
console.log(JSON.stringify(r[0]));
await sql.end();
