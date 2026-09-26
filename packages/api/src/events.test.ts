import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { closeChangeStream, closeDb, getServiceSql, subscribeToChanges, type ChangeEvent } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * Live updates. The two things worth proving:
 *
 *  1. A write really does reach a listener, through Postgres, without anyone polling.
 *  2. The event carries NO ROW CONTENT — only the table and the operation. That is the whole
 *     security argument for fanning one shared stream out to every viewer, so it gets a test
 *     that fails loudly if anyone ever adds an id "just for convenience".
 */
const app = buildServer(false);
const TAG = "EVT-";

afterAll(async () => {
  const sql = getServiceSql();
  await sql`delete from task where title like ${`${TAG}%`}`;
  await sql`delete from employee where display_name like ${`${TAG}%`}`;
  await closeChangeStream();
  await app.close();
  await closeDb();
});

describe("the change stream", () => {
  it("delivers a notification when a row is written, carrying the table and nothing else", async () => {
    const seen: ChangeEvent[] = [];
    let fire: ((e: ChangeEvent) => void) | undefined;
    const arrived = new Promise<ChangeEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no change event arrived within 8s")), 8000);
      fire = (e) => {
        if (e.table !== "task") return;
        clearTimeout(timer);
        resolve(e);
      };
    });

    const unsubscribe = await subscribeToChanges((e) => {
      seen.push(e);
      fire?.(e);
    });

    const sql = getServiceSql();
    const emp = randomUUID();
    await sql`insert into employee (id, display_name, status, is_synthetic)
              values (${emp}, ${`${TAG}person`}, 'active', true)`;
    await sql`insert into task (employee_id, title, status, is_synthetic)
              values (${emp}, ${`${TAG}a task`}, 'open', true)`;

    const e = await arrived;
    expect(e.table).toBe("task");
    expect(e.op).toBe("insert");
    expect(typeof e.at).toBe("number");

    // THE SECURITY ASSERTION: the payload is exactly these three fields. An id, an employee
    // or a project here would be a channel straight past RLS, because one listening
    // connection is shared by every signed-in viewer.
    expect(Object.keys(e).sort()).toEqual(["at", "op", "table"]);
    unsubscribe();
  });

  it("one statement that touches many rows rings the bell once, not once per row", async () => {
    const sql = getServiceSql();
    const emp = randomUUID();
    await sql`insert into employee (id, display_name, status, is_synthetic)
              values (${emp}, ${`${TAG}bulk`}, 'active', true)`;
    for (let i = 0; i < 5; i++) {
      await sql`insert into task (employee_id, title, status, is_synthetic)
                values (${emp}, ${`${TAG}bulk ${i}`}, 'open', true)`;
    }

    const updates: ChangeEvent[] = [];
    const unsubscribe = await subscribeToChanges((e) => {
      if (e.table === "task" && e.op === "update") updates.push(e);
    });
    // One UPDATE statement, five rows.
    await sql`update task set priority = 'high' where employee_id = ${emp}`;
    await new Promise((r) => setTimeout(r, 1500));
    unsubscribe();

    expect(updates.length).toBe(1);
  });
});

describe("GET /dashboard/events", () => {
  /**
   * A real socket, not `inject`: `inject` resolves when the response ENDS, and the whole
   * point of this endpoint is that it does not end. So the server is listened on a real
   * ephemeral port, the first frames are read off the body, and the request is aborted.
   */
  it("opens an SSE stream, announces itself, and pushes a change without anyone polling", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const controller = new AbortController();

    const res = await fetch(`http://127.0.0.1:${port}/dashboard/events?viewer=ceo`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // A failed assertion must still close the stream: otherwise the open connection keeps the
    // server alive and the teardown hook times out instead of the test failing cleanly.
    onTestFinished(async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    });
    const readUntil = async (needle: string, ms = 8000): Promise<string> => {
      const deadline = Date.now() + ms;
      while (!buffer.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`stream never produced ${needle}; got: ${buffer.slice(0, 300)}`);
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended unexpectedly");
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    };

    await readUntil("event: hello");
    expect(buffer).toContain("retry:"); // the browser is told when to reconnect itself

    // Now write something and prove it arrives down the open stream.
    const sql = getServiceSql();
    const emp = randomUUID();
    await sql`insert into employee (id, display_name, status, is_synthetic)
              values (${emp}, ${`${TAG}sse`}, 'active', true)`;
    await sql`insert into task (employee_id, title, status, is_synthetic)
              values (${emp}, ${`${TAG}pushed`}, 'open', true)`;

    // Wait for the TASK frame specifically: the employee insert above rings the bell too,
    // and which of the two arrives first is a race not worth depending on.
    await readUntil(`"table":"task"`);
    const line = buffer.split("\n").find((l) => l.startsWith("data:") && l.includes(`"table":"task"`))!;
    const payload = JSON.parse(line.slice(5)) as Record<string, unknown>;
    expect(payload["table"]).toBe("task");
    // The same security assertion, this time on what actually crosses the wire.
    expect(Object.keys(payload).sort()).toEqual(["at", "op", "table"]);
  });
});
