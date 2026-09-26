// Defence in depth for the NL-query: the query also runs inside a READ ONLY
// transaction (see answer.ts), but we reject obviously non-read-only SQL early.
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|truncate|grant|revoke|copy|create)\b/i;

/**
 * Schemas the question box must never reach.
 *
 * `auth` holds Supabase's `users`, `identities` and `refresh_tokens` — password hashes and
 * session tokens. The query now runs as the RLS-enforced app role, which has no privileges
 * there at all, so this is the second lock rather than the first. It exists so a question
 * that even ATTEMPTS one of these is refused with a reason a person can read, instead of
 * surfacing a raw permission error that looks like a bug.
 *
 * `pg_catalog` and `information_schema` are excluded for the same reason: they are how you
 * enumerate a database you were not handed, and no operational question needs them.
 */
const FORBIDDEN_SCHEMA =
  /\b(auth|storage|vault|extensions|realtime|supabase_functions|pg_catalog|information_schema)\s*\./i;
/** Catalogue tables and session functions reachable without a schema prefix. */
const FORBIDDEN_TABLE = /\b(pg_[a-z_]+|current_setting|set_config)\b/i;

export interface GuardResult {
  ok: boolean;
  sql: string;
  reason?: string;
}

/** Accept a single read-only SELECT/WITH; append a LIMIT if missing. */
export function validateReadOnlySql(raw: string, maxRows = 50): GuardResult {
  let s = raw.trim().replace(/;+\s*$/, ""); // strip trailing semicolons
  if (s.includes(";")) return { ok: false, sql: s, reason: "multiple statements" };
  if (!/^(select|with)\b/i.test(s)) {
    return { ok: false, sql: s, reason: "must start with SELECT/WITH" };
  }
  if (FORBIDDEN.test(s)) return { ok: false, sql: s, reason: "forbidden keyword" };
  if (FORBIDDEN_SCHEMA.test(s)) {
    return { ok: false, sql: s, reason: "only the application schema may be queried" };
  }
  if (FORBIDDEN_TABLE.test(s)) {
    return { ok: false, sql: s, reason: "system catalogues and session functions are not queryable" };
  }

  // Wrap rather than append.
  //
  // The old check was `if the text contains "limit <n>" anywhere, assume it is capped`.
  // A LIMIT inside a subquery — `select * from (select ... limit 1000) x` — satisfied
  // that test, so no outer limit was added and the model could return an unbounded
  // result set. MAX_ROWS was then enforced only by a JS slice, after Postgres had
  // already materialised every row (CLAUDE.md rule 4 says bounded, and it was not).
  //
  // Wrapping makes the cap structural: whatever the inner query does, the outer LIMIT
  // is the last word. A subquery cannot escape its own parentheses.
  s = `select * from (${s}) as bounded_result limit ${maxRows}`;
  return { ok: true, sql: s };
}
