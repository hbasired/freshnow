import postgres from "postgres";
import { config } from "dotenv";
config({ path: "C:/Users/acer/Downloads/freshnow/.env" });
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { max: 1, onnotice: () => {} });
const t = await sql`select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('route_plan','route_plan_member','route_stop','visit','visit_evidence','visit_doc') order by 1`;
const caps = await sql`select role, capability from role_capability where capability in ('routes.plan','visits.record') order by 2,1`;
const [m] = await sql`select count(*)::int as machines, count(*) filter (where asset_no is not null and status = 'active')::int as numbered_active, count(service_shift)::int as ruled from machine`;
const [p] = await sql`select (select count(*)::int from route_plan) as plans, (select count(*)::int from visit) as visits`;
console.log(JSON.stringify({ tables: t, caps: caps.map((c) => `${c.capability}:${c.role}`), machines: m, rows: p }));
await sql.end();
