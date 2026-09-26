import { getServiceSql } from "@freshnow/core";
import type { StorageAdapter } from "grammy";

/**
 * grammY session storage backed by Postgres.
 *
 * The default storage is in-memory, so every restart dropped every half-finished
 * conversation — a worker would send their invite code into a bot that had forgotten
 * it ever asked. Persisting the step makes onboarding and task logging survive
 * restarts, deploys, and crashes.
 */
export function postgresSessionStorage<T>(): StorageAdapter<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      const sql = getServiceSql();
      const rows = await sql<{ value: T }[]>`
        select value from bot_session where key = ${key}`;
      return rows[0]?.value;
    },

    async write(key: string, value: T): Promise<void> {
      const sql = getServiceSql();
      await sql`
        insert into bot_session (key, value, updated_at)
        values (${key}, ${sql.json(value as never)}, now())
        on conflict (key) do update
          set value = excluded.value, updated_at = now()`;
    },

    async delete(key: string): Promise<void> {
      const sql = getServiceSql();
      await sql`delete from bot_session where key = ${key}`;
    },
  };
}
