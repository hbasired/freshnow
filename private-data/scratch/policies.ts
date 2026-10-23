import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const p = await sql`select cmd, count(*)::int n, count(*) filter (where coalesce(qual,'') || coalesce(with_check,'') like '%app_is_ceo()%')::int uses_ceo,
  count(distinct tablename)::int tables from pg_policies where schemaname = 'public' group by cmd order by cmd`;
console.table(p);
const t = await sql`select count(*)::int n from pg_tables where schemaname = 'public' and rowsecurity`;
console.log("tables with RLS:", t[0].n);
await sql.end();
