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
const openStreams: Array<() => Promise<void>> = [];

/** The port the app listens on — once, for every test in this file that needs a real socket. */
let port = 0;
async function listening(): Promise<number> {
  if (port) return port;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  port = typeof address === "object" && address ? address.port : 0;
  return port;
}

/** A live stream read off a real socket, frame by frame. */
async function stream(viewer: string) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${await listening()}/dashboard/events?viewer=${viewer}`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  const frames: string[] = [];
  let ended = false;
  let buffer = "";
  const reading = (async () => {
    if (!res.body || !res.ok) return; // a refusal is plain JSON, left for the test to read
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        frames.push(...parts.filter((f) => f.trim()));
      }
    } catch {
      /* aborted */
    }
    ended = true;
  })();
  const close = async () => {
    controller.abort();
    await reading;
  };
  openStreams.push(close);
  const until = async (ok: () => boolean, what: string, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`${viewer}: never saw ${what}; frames: ${JSON.stringify(frames)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /** The data of every `change` frame about `table`, in arrival order. */
  const changes = (table: string) =>
    frames
      .filter((f) => f.startsWith("event: change"))
      .map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as Record<string, unknown>)
      .filter((d) => d["table"] === table);
  return { res, frames, changes, until, close, get ended() { return ended; } };
}

afterAll(async () => {
  for (const close of openStreams.splice(0)) await close();
  delete process.env.LIVE_MAX_STREAMS_PER_PERSON;
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
    const port = await listening();
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

describe("GET /dashboard/events — only the people a change concerns (TASK-058)", () => {
  const person = async (name: string, role = "employee"): Promise<string> => {
    const id = randomUUID();
    await getServiceSql()`insert into employee (id, display_name, status, is_synthetic, access_role)
                          values (${id}, ${`${TAG}${name}`}, 'active', true, ${role})`;
    return id;
  };
  const task = (owner: string, title: string) =>
    getServiceSql()`insert into task (employee_id, title, status, is_synthetic) values (${owner}, ${`${TAG}${title}`}, 'open', true)`;

  it("a change to one person's work reaches their stream and not a stranger's — three keys on the wire", async () => {
    const A = await person("A");
    const B = await person("B");
    const a = await stream(A);
    const b = await stream(B);
    expect(a.res.status).toBe(200);
    await a.until(() => a.frames.some((f) => f.startsWith("event: hello")), "hello");
    await b.until(() => b.frames.some((f) => f.startsWith("event: hello")), "hello");

    // Notifications arrive in commit order, so by the time a stream sees its own second change,
    // it would already have seen the other person's change in between — if it were sent to it.
    await task(A, "A1");
    await task(B, "B1");
    await task(A, "A2");
    await task(B, "B2");
    await a.until(() => a.changes("task").length >= 2, "two task changes");
    await b.until(() => b.changes("task").length >= 2, "two task changes");
    expect(a.changes("task")).toHaveLength(2);
    expect(b.changes("task")).toHaveLength(2);
    for (const d of [...a.changes("task"), ...b.changes("task")]) {
      expect(Object.keys(d).sort()).toEqual(["at", "op", "table"]);
    }
    await a.close();
    await b.close();
  });

  it("the CEO's stream hears every person's change", async () => {
    const C = await person("C");
    const ceo = await stream("ceo");
    await ceo.until(() => ceo.frames.some((f) => f.startsWith("event: hello")), "hello");
    await task(C, "C1");
    await ceo.until(() => ceo.changes("task").length >= 1, "a task change");
    await ceo.close();
  });

  it("one person holds only so many streams; past that they are told to keep polling", async () => {
    process.env.LIVE_MAX_STREAMS_PER_PERSON = "1";
    const D = await person("D");
    const first = await stream(D);
    expect(first.res.status).toBe(200);
    const second = await stream(D);
    expect(second.res.status).toBe(503);
    expect(await second.res.json()).toMatchObject({ error: { code: "too_many_streams" } });
    await first.close();
    // The slot is given back when the stream closes.
    await new Promise((r) => setTimeout(r, 100));
    const third = await stream(D);
    expect(third.res.status).toBe(200);
    await third.close();
    delete process.env.LIVE_MAX_STREAMS_PER_PERSON;
  });

  it("a person switched off loses their stream as soon as that change is heard", async () => {
    const E = await person("E");
    const s = await stream(E);
    await s.until(() => s.frames.some((f) => f.startsWith("event: hello")), "hello");
    await getServiceSql()`update employee set status = 'disabled' where id = ${E}`;
    await s.until(() => s.ended, "the stream end");
  });
});
