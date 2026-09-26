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
 */

export interface ChangeEvent {
  table: string;
  op: "insert" | "update" | "delete";
  /** Milliseconds since the epoch, from the database's clock, not this process's. */
  at: number;
}

export type ChangeListener = (e: ChangeEvent) => void;

const CHANNEL = "freshnow_change";

let listenSql: postgres.Sql<Record<string, never>> | undefined;
let listening: Promise<void> | undefined;
const listeners = new Set<ChangeListener>();

/** Every subscriber is called; one throwing must not silence the rest. */
function fanOut(payload: string): void {
  let e: ChangeEvent;
  try {
    const raw = JSON.parse(payload) as { table?: unknown; op?: unknown; at?: unknown };
    if (typeof raw.table !== "string" || typeof raw.op !== "string") return;
    e = {
      table: raw.table,
      op: raw.op as ChangeEvent["op"],
      at: typeof raw.at === "number" ? raw.at : Number(raw.at ?? Date.now()),
    };
  } catch {
    return; // a payload we cannot read is not worth crashing a stream for
  }
  for (const fn of listeners) {
    try {
      fn(e);
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
  listening ??= listenSql.listen(CHANNEL, fanOut).then(() => undefined);
  try {
    await listening;
  } catch (err) {
    // Leave the door open for the next subscriber to retry rather than caching a failure.
    listening = undefined;
    listeners.delete(fn);
    throw err;
  }
  return () => {
    listeners.delete(fn);
  };
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
