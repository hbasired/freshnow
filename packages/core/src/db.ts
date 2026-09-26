import postgres from "postgres";

export type Db = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;

let appSql: Db | undefined;
let serviceSql: Db | undefined;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Every connection runs in COMPANY time.
 *
 * The container's Postgres is `Etc/UTC`, so `'2026-09-09'::date` meant midnight UTC —
 * 04:00 in Dubai. Every "one day" window in the system was therefore shifted four hours:
 * an end-of-day report silently excluded work reported between midnight and 04:00 and
 * silently included the previous evening's. `companyToday()` fixed which date STRING we
 * ask for; this fixes what that date MEANS once Postgres reads it.
 *
 * Set on the connection rather than patched into 21 individual queries, because the
 * next query written would have had the same bug and nothing would have caught it.
 * `timestamptz` storage is unaffected — only the interpretation of date/timestamp casts
 * changes, which is exactly what a day boundary needs.
 */
const CONNECTION_OPTS = {
  max: 5,
  onnotice: () => {},
  connection: { timezone: "Asia/Dubai" },
} as const;

/** App-role client — RLS ENFORCED. Use for all user-facing reads/writes. */
export function getAppSql(): Db {
  appSql ??= postgres(requireEnv("DATABASE_URL"), CONNECTION_OPTS);
  return appSql;
}

/** Service-role client — BYPASSRLS. Worker/outbox only; never for user-facing reads. */
export function getServiceSql(): Db {
  serviceSql ??= postgres(requireEnv("DATABASE_URL_SERVICE"), CONNECTION_OPTS);
  return serviceSql;
}

export type AccessRole = "ceo" | "manager" | "lead" | "employee";

export interface AppContext {
  employeeId?: string;
  isCeo?: boolean;
  /**
   * What the viewer may do — read by app_access_role() inside the policies (migration
   * 0009). Absent means "employee", which is the most restrictive answer, so forgetting
   * to pass it can only hide rows, never leak them.
   */
  accessRole?: AccessRole;
  /** The viewer's department; a lead sees everyone in it. */
  department?: string | null;
}

/**
 * Run `fn` inside a transaction with the per-request RLS context set via
 * `set_config(..., is_local => true)` — the parameterized form of `SET LOCAL`,
 * scoped to this transaction so a pooled connection cannot leak one user's
 * context into the next request (the classic RLS footgun).
 */
export async function withContext<T>(
  ctx: AppContext,
  fn: (sql: Tx) => Promise<T>,
  opts: { readOnly?: boolean } = {},
): Promise<T> {
  const sql = getAppSql();
  return sql.begin(async (tx) => {
    // `SET TRANSACTION READ ONLY` is only accepted BEFORE the first query of the
    // transaction — and `select set_config(...)` is a query. Issued after them it throws
    // "transaction read-write mode must be set before any query", which is how the
    // question box briefly abstained on every question (2026-09-18). So it goes first.
    if (opts.readOnly) await tx`set transaction read only`;
    await tx`select set_config('app.employee_id', ${ctx.employeeId ?? ""}, true)`;
    await tx`select set_config('app.is_ceo', ${ctx.isCeo ? "on" : "off"}, true)`;
    await tx`select set_config('app.access_role', ${ctx.accessRole ?? ""}, true)`;
    await tx`select set_config('app.department', ${ctx.department ?? ""}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Close pooled connections (used by tests). */
export async function closeDb(): Promise<void> {
  await Promise.all([appSql?.end(), serviceSql?.end()]);
  appSql = undefined;
  serviceSql = undefined;
}
