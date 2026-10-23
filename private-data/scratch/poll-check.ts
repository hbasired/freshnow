import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const r = await sql`select job_name, status, created_at from job_run where job_name in ('email_poll','televend_sync') and created_at > now() - interval '15 minutes' order by created_at desc limit 6`;
for (const x of r) console.log(x.job_name, x.status, new Date(x.created_at.getTime() + 4 * 3_600_000).toISOString().slice(11, 19), "Dubai");
await sql.end();
