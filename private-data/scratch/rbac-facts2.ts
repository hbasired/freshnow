import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
for (const f of ["app_can_view_project", "app_can_view_employee", "app_is_ceo", "app_access_role", "app_current_employee"]) {
  const r = await sql`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = ${f}`;
  console.log(`=== ${f}\n${r.map((x) => x.def).join("\n")}`);
}
const others = await sql`select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public' and (coalesce(qual,'') like '%app_can_view_project%' or coalesce(qual,'') like '%app_access_role%') order by tablename`;
for (const p of others) console.log(`${p.cmd} ${p.tablename}.${p.policyname}: ${p.qual}`);
await sql.end();
