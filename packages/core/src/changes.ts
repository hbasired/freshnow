import postgres from "postgres";

/**
 * One listening connection to Postgres, fanned out to many subscribers in this process.
 *
 * `LISTEN` occupies a connection for as long as it is listening, so this must never be taken
 * from the pooled clients — a pool of 5 with one permanently blocked is a pool of 4, and the
 * failure looks like unrelated queries hanging. It gets its own single-connection client.
 *
 * What arrives here carries NO row content (see migration 0013): the table and the operation,
 * nothing else. Subscribers use it only as a signal to re-fetch through the ordinary
 * RLS-scoped endpoints. That is what makes a shared stream safe to fan out to every viewer.
 *
 * Since migration 0027 the notification also says WHOM a change concerns — its scope — so the
 * API can ring only the doorbells of people who may see it (live-audience.ts). The scope is handed
 * to listeners as a separate argument, never as a field of the event, so the object a stream
 * writes to a browser cannot carry it by accident.
 */

export interface ChangeEvent {
  table: string;
  op: "insert" | "update" | "delete";
  /** Milliseconds since the epoch, from the database's clock, not this process's. */
  at: number;
}

/**
 * Whom a change concerns (migration 0027): `e:<employee>` (whoever may see that person),
 * `s:<employee>` (that person only), `p:<project>` (whoever may see that project), `org` (who may
 * see whom changed: everyone is told) or `*` (unknown: everyone is told). Empty: only those who
 * read everything. For the API's decision only — never forwarded to a client.
 */
export type ChangeScope = readonly string[];

export type ChangeListener = (e: ChangeEvent, scope: ChangeScope) => void;

const CHANNEL = "freshnow_change";
/** A notification without a readable scope (an older trigger, a hand-sent NOTIFY) reaches everyone. */
const EVERYONE: ChangeScope = Object.freeze(["*"]);

let listenSql: postgres.Sql<Record<string, never>> | undefined;
let listening: Promise<void> | undefined;
const listeners = new Set<ChangeListener>();
/** Counts `org` changes, so anything that cached "who may see whom" knows it is out of date. */
let orgChanges = 0;

/** Every subscriber is called; one throwing must not silence the rest. */
function fanOut(payload: string): void {
  let e: ChangeEvent;
  let scope: ChangeScope;
  try {
    const raw = JSON.parse(payload) as { table?: unknown; op?: unknown; at?: unknown; scope?: unknown };
    if (typeof raw.table !== "string" || typeof raw.op !== "string") return;
    e = {
      table: raw.table,
      op: raw.op as ChangeEvent["op"],
      at: typeof raw.at === "number" ? raw.at : Number(raw.at ?? Date.now()),
    };
    scope =
      Array.isArray(raw.scope) && raw.scope.every((k): k is string => typeof k === "string")
        ? Object.freeze([...raw.scope])
        : EVERYONE;
  } catch {
    return; // a payload we cannot read is not worth crashing a stream for
  }
  // Before any listener runs, so none of them decides with a stale picture of who sees whom.
  if (scope.includes("org")) orgChanges++;
  for (const fn of listeners) {
    try {
      fn(e, scope);
    } catch {
      /* a broken subscriber must not stop the others */
    }
  }
}

/**
 * Subscribe to database changes. Returns an unsubscribe function; the underlying LISTEN is
 * opened on the first subscriber and kept afterwards (re-opening it per subscriber would
 * mean a connection per browser tab).
 *
 * postgres.js reconnects a dropped listener itself and re-issues the LISTEN; `onlisten`
 * fires again on each reconnect. Clients still hold their poll as a fallback, because a
 * reconnect that silently fails would otherwise look like "nothing is happening".
 */
export async function subscribeToChanges(fn: ChangeListener): Promise<() => void> {
  listeners.add(fn);
  listenSql ??= postgres(
    process.env.DATABASE_URL_SERVICE ?? process.env.DATABASE_URL ?? "",
    { max: 1, onnotice: () => {}, connection: { timezone: "Asia/Dubai" } },
  );
  // `onlisten` runs on the first LISTEN and again after every reconnect. Notifications sent while the
  // connection was down are lost — some may have been org changes — so every (re)listen counts as one:
  // each cached picture of who sees what is reloaded rather than trusted (TASK-058 review).
  const conn = listenSql;
  listening ??= conn.listen(CHANNEL, fanOut, () => {
    orgChanges++;
  }).then(() => undefined);
  try {
    await listening;
  } catch (err) {
    listeners.delete(fn);
    // Leave the door open for the next subscriber to retry rather than caching a failure — on a FRESH
    // connection: postgres.js keeps the listener of a LISTEN that failed and re-listens it on reconnect,
    // so retrying on the same one stacks a listener per attempt and, once LISTEN works, delivers every
    // change that many times (review 2026-10-17, live-updates-media#3).
    if (listenSql === conn) {
      listenSql = undefined;
      listening = undefined;
      await conn.end({ timeout: 1 }).catch(() => {});
    }
    throw err;
  }
  return () => {
    listeners.delete(fn);
  };
}

/** How many `org` changes this process has heard; a cache loaded at an older count is stale. */
export function orgChangeCount(): number {
  return orgChanges;
}

/** How many subscribers are attached — used by /health to show the stream is alive. */
export function changeSubscriberCount(): number {
  return listeners.size;
}

/** Close the listening connection. Tests and shutdown only. */
export async function closeChangeStream(): Promise<void> {
  listeners.clear();
  listening = undefined;
  await listenSql?.end();
  listenSql = undefined;
}
