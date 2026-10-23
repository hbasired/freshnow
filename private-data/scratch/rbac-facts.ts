import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const chk = await sql`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid = 'employee'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%access_role%'`;
console.log("CHECK:", chk);
const pol = await sql`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies
  where schemaname = 'public' and (coalesce(qual,'') || coalesce(with_check,'')) like '%app_is_ceo()%' order by cmd, tablename, policyname`;
for (const p of pol) console.log(`${p.cmd.padEnd(6)} ${p.tablename}.${p.policyname} roles=${p.roles}\n   using: ${p.qual ?? "-"}\n   check: ${p.with_check ?? "-"}`);
await sql.end();
