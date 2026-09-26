import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "./db.js";

/**
 * The semantic layer is what a model is given instead of the real schema. If it disagrees
 * with the database, the model writes SQL that fails — or worse, SQL that runs against the
 * wrong column and returns a confident wrong number.
 *
 * This file used to check TABLE NAMES ONLY. An audit on 2026-09-18 found it passing while
 * `schema_migrations.filename` was documented (the real column is `name`),
 * `project_member.is_synthetic` was documented but did not exist, and four real columns
 * including `employee.role_title` — the one a model most easily confuses with
 * `access_role` — were undocumented. A test that cannot fail on any of those is not
 * covering the thing it claims to cover, so it now checks both directions, per column.
 */

/** Tables whose columns are deliberately not enumerated, with the reason. */
const COLUMN_CHECK_EXEMPT = new Set<string>([
  // Supabase's own migration ledger; `version` is theirs and we never query it.
  "schema_migrations",
]);

/**
 * Columns that exist but are deliberately undocumented, with the reason. Keep this list
 * short and justified — it is the escape hatch that could quietly re-open the gap.
 */
const UNDOCUMENTED_BY_DESIGN: Record<string, string[]> = {
  // Surrogate keys on pure join tables add nothing a model can use.
  project_member: ["id"],
  task_watcher: ["id"],
};

function documentedColumns(yaml: string, table: string): Set<string> | null {
  // Each table is `  <name>:` at two spaces; its `columns:` block is at four, and each
  // column is a `      key:` at six. Stop at the next two-space key.
  const start = yaml.search(new RegExp(`\\n  ${table}:`));
  if (start === -1) return null;
  const rest = yaml.slice(start + 1);
  const end = rest.search(/\n {2}\w[\w_]*:/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const cols = block.match(/\n {6}([a-z_][a-z0-9_]*):/g) ?? [];
  return new Set(cols.map((c) => c.trim().replace(":", "")));
}

describe("semantic layer stays in sync with the schema", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("every base table in public appears in semantic/schema.yaml", async () => {
    const yaml = readFileSync(join(process.cwd(), "semantic", "schema.yaml"), "utf8");
    const sql = getServiceSql();
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`;
    const missing = rows
      .map((r) => r.table_name)
      .filter((t) => !new RegExp(`\\n  ${t}:`).test(yaml));
    expect(missing).toEqual([]);
  });

  it("documents no column that does not exist", async () => {
    const yaml = readFileSync(join(process.cwd(), "semantic", "schema.yaml"), "utf8");
    const sql = getServiceSql();
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE')`;

    const real = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!real.has(r.table_name)) real.set(r.table_name, new Set());
      real.get(r.table_name)!.add(r.column_name);
    }

    const phantom: string[] = [];
    for (const [table, columns] of real) {
      if (COLUMN_CHECK_EXEMPT.has(table)) continue;
      const documented = documentedColumns(yaml, table);
      if (!documented) continue; // the table-level test above owns that failure
      for (const c of documented) if (!columns.has(c)) phantom.push(`${table}.${c}`);
    }
    // A documented column that does not exist is the worst kind: the model trusts it.
    expect(phantom.sort()).toEqual([]);
  });

  it("documents every column that does exist", async () => {
    const yaml = readFileSync(join(process.cwd(), "semantic", "schema.yaml"), "utf8");
    const sql = getServiceSql();
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE')
      order by table_name, ordinal_position`;

    const undocumented: string[] = [];
    for (const r of rows) {
      if (COLUMN_CHECK_EXEMPT.has(r.table_name)) continue;
      if (UNDOCUMENTED_BY_DESIGN[r.table_name]?.includes(r.column_name)) continue;
      const documented = documentedColumns(yaml, r.table_name);
      if (!documented) continue;
      if (!documented.has(r.column_name)) undocumented.push(`${r.table_name}.${r.column_name}`);
    }
    expect(undocumented.sort()).toEqual([]);
  });
});
