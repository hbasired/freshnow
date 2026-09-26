import { describe, expect, it } from "vitest";
import { validateReadOnlySql } from "./guard.js";

describe("validateReadOnlySql", () => {
  it("accepts a SELECT and appends a LIMIT when missing", () => {
    const r = validateReadOnlySql("select count(*) from blocker");
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/limit 50$/i);
  });

  it("keeps the caller's own LIMIT and still caps the total", () => {
    const r = validateReadOnlySql("select * from blocker limit 5");
    expect(r.ok).toBe(true);
    // The inner limit is preserved, so a query asking for 5 still gets 5...
    expect(r.sql).toContain("limit 5");
    // ...and the outer cap is always present regardless.
    expect(r.sql).toMatch(/limit 50$/i);
  });

  it("caps a query whose only LIMIT is inside a subquery", () => {
    // The old check was "does the text contain 'limit <n>' anywhere?", which this
    // satisfied — so no outer limit was added and the result set was unbounded, with
    // MAX_ROWS enforced only by a JS slice after Postgres had materialised every row.
    const r = validateReadOnlySql("select * from (select * from task limit 100000) x");
    expect(r.ok).toBe(true);
    expect(r.sql).toMatch(/limit 50$/i);
  });

  it("rejects writes", () => {
    expect(validateReadOnlySql("delete from employee").ok).toBe(false);
    expect(validateReadOnlySql("drop table blocker").ok).toBe(false);
    expect(validateReadOnlySql("update employee set status='x'").ok).toBe(false);
    expect(validateReadOnlySql("truncate blocker").ok).toBe(false);
  });

  it("rejects multiple statements", () => {
    expect(validateReadOnlySql("select 1; drop table x").ok).toBe(false);
  });
});

/**
 * The question box hands a model a database connection. These lock down what that
 * connection may be pointed at — the schemas below hold password hashes and refresh
 * tokens, and an audit on 2026-09-18 found the query running as a BYPASSRLS role that
 * could read them. The role was changed; this is the second lock.
 */
describe("schemas and catalogues the question box must never reach", () => {
  const refused = [
    ["Supabase auth users", "select email from auth.users"],
    ["refresh tokens", "select * from auth.refresh_tokens"],
    ["identities", "SELECT * FROM Auth.Identities"],
    ["storage", "select * from storage.objects"],
    ["the catalogue by schema", "select * from pg_catalog.pg_roles"],
    ["the catalogue bare", "select rolname from pg_roles"],
    ["information_schema", "select table_name from information_schema.tables"],
    ["session settings", "select current_setting('app.is_ceo')"],
    ["set_config as a read", "select set_config('app.is_ceo','on',false)"],
  ] as const;

  for (const [label, sql] of refused) {
    it(`refuses ${label}`, () => {
      const r = validateReadOnlySql(sql);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/application schema|system catalogues/);
    });
  }

  it("still accepts an ordinary question over the business tables", () => {
    const r = validateReadOnlySql("select count(*) from blocker where status = 'open'");
    expect(r.ok).toBe(true);
    expect(r.sql).toContain("bounded_result");
  });

  it("does not refuse a legitimate column that merely contains a forbidden word", () => {
    // `progress_source` and `department` are real columns; a substring match on
    // "pg_" or "auth" must not swallow them.
    expect(validateReadOnlySql("select progress_source from task").ok).toBe(true);
    expect(validateReadOnlySql("select department from employee").ok).toBe(true);
  });
});
