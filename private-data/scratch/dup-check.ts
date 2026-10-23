import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
// Would the new API-identity index be violated by rows already stored?
const d = await sql`select machine_tv_id, at, coalesce(column_no, -1) col, raw->>'fill_type' ft, quantity_change, count(*)::int n
  from tv_refill where source = 'bridge' and machine_tv_id is not null group by 1,2,3,4,5 having count(*) > 1`;
console.log("duplicate API identities already stored:", d.length);
const ms = await sql`select count(*) filter (where extract(microseconds from at)::int % 1000 <> 0)::int sub_ms, count(*)::int n from tv_refill where source = 'bridge'`;
console.log("bridge rows with sub-millisecond precision:", ms[0]);
await sql.end();
