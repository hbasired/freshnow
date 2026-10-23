import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const m = await sql`select count(*)::int n, count(*) filter (where enabled)::int enabled from tv_machine where asset_no is null`;
const r = await sql`select count(*)::int n from tv_refill f join tv_machine m on m.televend_id = f.machine_tv_id where m.asset_no is null`;
console.log("machines without an asset number:", m[0], "| refills stored for them:", r[0].n);
await sql.end();
