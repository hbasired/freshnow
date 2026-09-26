import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";

/**
 * A guard for a bug that shipped silently: migration 0001 grants privileges with
 * `on ALL TABLES IN SCHEMA public`, which covers only the tables that existed when it
 * ran. Every table added by a later migration got a correct RLS policy and no grant
 * behind it, so the RLS-enforced role could not read it at all — the policy said yes,
 * the privilege said nothing, and the dashboard returned a 500.
 *
 * RLS decides WHICH ROWS. The grant decides whether the role may look at all. Both are
 * required, and only one of them is easy to forget.
 */
afterAll(async () => {
  await closeDb();
});

describe("privileges keep pace with migrations", () => {
  it("gives the RLS-enforced app role SELECT on every base table", async () => {
    const sql = getServiceSql();
    const missing = await sql<{ table_name: string }[]>`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and not has_table_privilege('freshnow_app', c.oid, 'SELECT')
      order by c.relname`;
    expect(missing.map((r) => r.table_name)).toEqual([]);
  });

  it("keeps the audit log append-only for the app role", async () => {
    const sql = getServiceSql();
    const [row] = await sql<{ ins: boolean; upd: boolean; del: boolean }[]>`
      select has_table_privilege('freshnow_app', 'audit_log', 'INSERT') as ins,
             has_table_privilege('freshnow_app', 'audit_log', 'UPDATE') as upd,
             has_table_privilege('freshnow_app', 'audit_log', 'DELETE') as del`;
    // A blanket re-grant must never hand back the ability to rewrite history.
    expect(row!.ins).toBe(true);
    expect(row!.upd).toBe(false);
    expect(row!.del).toBe(false);
  });
});
