import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, withContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import {
  addTaskStep,
  bandMidpoint,
  closeTask,
  linkTasks,
  PROGRESS_BANDS,
  recomputeProgress,
  reportProgress,
  resolveBlocker,
  setStepDone,
} from "./progress.js";
import { createTask, recordTaskUpdate } from "./updates.js";

/**
 * A percentage must be evidence. These tests pin the three sources and the order they
 * win in, the mandatory note on an override, the append-only history, the bounded
 * relation graph, and the status/resolution pairing — the rules that keep "90% done for
 * three weeks" a query rather than a mystery.
 */

const who = randomUUID();
const other = randomUUID();

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic) values (${who}, 'PRG-Person', 'active', true), (${other}, 'PRG-Other', 'active', true)`;
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [who, other];
  await sql`delete from task_relation where from_task_id in (select id from task where employee_id = any(${ids}))`;
  await sql`delete from progress_event where task_id in (select id from task where employee_id = any(${ids}))`;
  await sql`delete from task_step where task_id in (select id from task where employee_id = any(${ids}))`;
  await sql`delete from blocker where raised_by = any(${ids})`;
  await sql`delete from task_update where employee_id = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`;
  await sql`delete from employee where id = any(${ids})`;
  await closeDb();
});

async function taskRow(id: string) {
  const [r] = await getServiceSql()<{ progress_pct: number; progress_source: string; status: string; resolution: string | null; started_at: Date | null }[]>`
    select progress_pct, progress_source, status, resolution, started_at from task where id = ${id}`;
  return r!;
}

describe("where the percentage comes from", () => {
  it("a new task is at its status percentage; a report moves the status and the percentage", async () => {
    const t = await createTask(who, "PRG status-derived", true);
    expect(await taskRow(t)).toMatchObject({ progress_pct: 0, progress_source: "status", started_at: null });

    await recordTaskUpdate({ taskId: t, employeeId: who, status: "in_progress" });
    const r = await taskRow(t);
    expect(r).toMatchObject({ progress_pct: 50, progress_source: "status", status: "in_progress" });
    expect(r.started_at).not.toBeNull();

    await recordTaskUpdate({ taskId: t, employeeId: who, status: "done" });
    expect(await taskRow(t)).toMatchObject({ progress_pct: 100, status: "done", resolution: "done" });
  });

  it("steps are counted, and counting wins over the status", async () => {
    const t = await createTask(who, "PRG counted", true);
    await recordTaskUpdate({ taskId: t, employeeId: who, status: "in_progress" }); // status says 50
    const a = await addTaskStep({ taskId: t, title: "drain the line", by: who });
    await addTaskStep({ taskId: t, title: "swap the filter", by: who });
    await addTaskStep({ taskId: t, title: "restart and log the temperature", by: who });
    await addTaskStep({ taskId: t, title: "sign the sheet", by: who });
    expect(await taskRow(t)).toMatchObject({ progress_pct: 0, progress_source: "counted" });

    await setStepDone({ stepId: a.id, done: true, by: who });
    expect(await taskRow(t)).toMatchObject({ progress_pct: 25, progress_source: "counted" });

    await setStepDone({ stepId: a.id, done: false, by: who });
    expect(await taskRow(t)).toMatchObject({ progress_pct: 0, progress_source: "counted" });
  });

  it("a self-reported figure needs a note, is labelled, and is replaced by the next countable change", async () => {
    const t = await createTask(who, "PRG self-reported", true);
    await expect(reportProgress({ taskId: t, employeeId: who, pct: 60, note: "" })).rejects.toThrow(/note/);
    await expect(reportProgress({ taskId: t, employeeId: who, pct: 140, note: "nearly there" })).rejects.toThrow(/0 to 100/);

    await reportProgress({ taskId: t, employeeId: who, pct: 60, note: "two of the three vans done" });
    expect(await taskRow(t)).toMatchObject({ progress_pct: 60, progress_source: "self_reported" });

    // Evidence arrives: a step is added and completed. The opinion gives way to the count.
    const s = await addTaskStep({ taskId: t, title: "van 3", by: who });
    await setStepDone({ stepId: s.id, done: true, by: who });
    expect(await taskRow(t)).toMatchObject({ progress_pct: 100, progress_source: "counted" });
  });

  it("a picked range is kept as the range, counted as its midpoint, and refused when off the list", async () => {
    const t = await createTask(who, "PRG band", true);
    // Off the list: not a ten-point step, reversed, or both a range and a figure at once.
    await expect(reportProgress({ taskId: t, employeeId: who, band: { low: 10, high: 30 }, note: "about a fifth" })).rejects.toThrow(/range/);
    await expect(reportProgress({ taskId: t, employeeId: who, band: { low: 20, high: 10 }, note: "about a fifth" })).rejects.toThrow(/range/);
    await expect(reportProgress({ taskId: t, employeeId: who, band: { low: 10, high: 20 }, pct: 15, note: "both" })).rejects.toThrow(/not both/);
    await expect(reportProgress({ taskId: t, employeeId: who, band: { low: 10, high: 20 }, note: "" })).rejects.toThrow(/note/);

    const r = await reportProgress({ taskId: t, employeeId: who, band: { low: 10, high: 20 }, note: "cleaned two of the machines" });
    expect(r).toEqual({ pct: 15, band: { low: 10, high: 20 } });
    const [row] = await getServiceSql()<{ progress_pct: number; progress_source: string; progress_band_low: number | null; progress_band_high: number | null }[]>`
      select progress_pct, progress_source, progress_band_low, progress_band_high from task where id = ${t}`;
    expect(row).toEqual({ progress_pct: 15, progress_source: "self_reported", progress_band_low: 10, progress_band_high: 20 });

    // The ends of the list: 0–10 counts as 5, 90–100 as 95 — never 100, which is Done.
    await reportProgress({ taskId: t, employeeId: who, band: { low: 90, high: 100 }, note: "final checks left" });
    expect(await taskRow(t)).toMatchObject({ progress_pct: 95, progress_source: "self_reported" });

    // An exact figure afterwards carries no band.
    await reportProgress({ taskId: t, employeeId: who, pct: 40, note: "recounted the crates" });
    const [exact] = await getServiceSql()<{ progress_band_low: number | null }[]>`select progress_band_low from task where id = ${t}`;
    expect(exact?.progress_band_low).toBeNull();

    // History keeps each range exactly as picked.
    const hist = await getServiceSql()<{ pct: number; band_low: number | null; band_high: number | null }[]>`
      select pct, band_low, band_high from progress_event where task_id = ${t} order by created_at`;
    expect(hist).toEqual([
      { pct: 15, band_low: 10, band_high: 20 },
      { pct: 95, band_low: 90, band_high: 100 },
      { pct: 40, band_low: null, band_high: null },
    ]);
  });

  it("the dashboard offers exactly the ranges the server accepts", async () => {
    // Read the browser's list from its source, untyped: the dashboard is a separate build, and
    // a list that drifted from this one would offer ranges the API refuses with a 400.
    const url = new URL("../../dashboard/src/lib/api.ts", import.meta.url).pathname;
    const browser = ((await import(url)) as { PROGRESS_BANDS: { low: number; high: number }[] }).PROGRESS_BANDS;
    expect(browser.map((b) => [b.low, b.high])).toEqual(PROGRESS_BANDS.map((b) => [b.low, b.high]));
    expect(PROGRESS_BANDS[0]).toEqual({ low: 0, high: 10 });
    expect(PROGRESS_BANDS.at(-1)).toEqual({ low: 90, high: 100 });
    expect(bandMidpoint({ low: 0, high: 10 })).toBe(5);
  });

  it("evidence replaces a picked range, and the range goes with it", async () => {
    const t = await createTask(who, "PRG band replaced", true);
    await reportProgress({ taskId: t, employeeId: who, band: { low: 30, high: 40 }, note: "halfway through the first van" });
    const s = await addTaskStep({ taskId: t, title: "van 1", by: who });
    await setStepDone({ stepId: s.id, done: true, by: who });
    const [row] = await getServiceSql()<{ progress_pct: number; progress_source: string; progress_band_low: number | null; progress_band_high: number | null }[]>`
      select progress_pct, progress_source, progress_band_low, progress_band_high from task where id = ${t}`;
    expect(row).toEqual({ progress_pct: 100, progress_source: "counted", progress_band_low: null, progress_band_high: null });
  });

  it("the database itself refuses a range on a figure nobody picked", async () => {
    const t = await createTask(who, "PRG band constraint", true);
    // status-derived progress with a band is a contradiction; so is a number outside its band.
    await expect(getServiceSql()`update task set progress_band_low = 0, progress_band_high = 10 where id = ${t}`).rejects.toThrow(/task_progress_band_ck/);
    await expect(
      getServiceSql()`update task set progress_source = 'self_reported', progress_pct = 50, progress_band_low = 0, progress_band_high = 10 where id = ${t}`,
    ).rejects.toThrow(/task_progress_band_ck/);
  });

  it("every change is appended to the history with its source", async () => {
    const t = await createTask(who, "PRG history", true);
    await reportProgress({ taskId: t, employeeId: who, pct: 30, note: "started the checks" });
    await recordTaskUpdate({ taskId: t, employeeId: who, status: "done" });
    const rows = await getServiceSql()<{ pct: number; source: string }[]>`
      select pct, source from progress_event where task_id = ${t} order by created_at`;
    expect(rows.map((r) => `${r.source}:${r.pct}`)).toEqual(["self_reported:30", "status:100"]);
  });

  it("recompute is idempotent — no event when nothing changed", async () => {
    const t = await createTask(who, "PRG idempotent", true);
    await recomputeProgress(t);
    await recomputeProgress(t);
    const rows = await getServiceSql()<{ n: number }[]>`select count(*)::int as n from progress_event where task_id = ${t}`;
    expect(rows[0]?.n).toBe(0);
  });
});

describe("relations", () => {
  it("writes the inverse, refuses a loop, and stops at the cap", async () => {
    const a = await createTask(who, "PRG rel A", true);
    const b = await createTask(who, "PRG rel B", true);
    const c = await createTask(who, "PRG rel C", true);
    await linkTasks({ fromTaskId: a, toTaskId: b, kind: "blocks", by: who });
    const rows = await getServiceSql()<{ from_task_id: string; to_task_id: string; kind: string }[]>`
      select from_task_id, to_task_id, kind from task_relation where from_task_id in (${a}, ${b}) order by kind`;
    expect(rows).toEqual([
      { from_task_id: b, to_task_id: a, kind: "blocked_by" },
      { from_task_id: a, to_task_id: b, kind: "blocks" },
    ]);

    await linkTasks({ fromTaskId: b, toTaskId: c, kind: "blocks", by: who });
    // c → a would close a → b → c → a.
    await expect(linkTasks({ fromTaskId: c, toTaskId: a, kind: "blocks", by: who })).rejects.toThrow(/loop/);
    // Stated the other way round, same loop.
    await expect(linkTasks({ fromTaskId: a, toTaskId: c, kind: "blocked_by", by: who })).rejects.toThrow(/loop/);
    // A symmetric relation on the same pair is fine.
    await linkTasks({ fromTaskId: c, toTaskId: a, kind: "relates", by: who });
    await expect(linkTasks({ fromTaskId: a, toTaskId: a, kind: "relates", by: who })).rejects.toThrow(/itself/);
  });
});

describe("resolution", () => {
  it("resolving a blocker records who and why; a closed task carries its reason", async () => {
    const sql = getServiceSql();
    const [b] = await sql<{ id: string }[]>`
      insert into blocker (raised_by, severity, status, category, is_synthetic) values (${who}, 'high', 'open', 'equipment', true) returning id`;
    await expect(resolveBlocker({ blockerId: b!.id, resolvedBy: other, note: "" })).rejects.toThrow(/how/);
    await resolveBlocker({ blockerId: b!.id, resolvedBy: other, note: "Replaced the compressor relay" });
    const [row] = await sql<{ status: string; resolved_by: string; resolution_note: string }[]>`
      select status, resolved_by, resolution_note from blocker where id = ${b!.id}`;
    expect(row).toMatchObject({ status: "resolved", resolved_by: other, resolution_note: "Replaced the compressor relay" });
    await expect(resolveBlocker({ blockerId: b!.id, resolvedBy: other, note: "again" })).rejects.toThrow(/not open/);

    const t = await createTask(who, "PRG wont do", true);
    await closeTask({ taskId: t, resolution: "wont_do", by: who });
    expect(await taskRow(t)).toMatchObject({ status: "cancelled", resolution: "wont_do", progress_pct: 0 });
  });
});

describe("visibility of the new tables follows the task", () => {
  it("steps and history of a task are visible to its owner and the CEO, not to a stranger", async () => {
    const t = await createTask(who, "PRG visible", true);
    await addTaskStep({ taskId: t, title: "one", by: who });
    const count = (ctx: { employeeId: string; isCeo?: boolean }) =>
      withContext(ctx, (sql) => sql<{ n: number }[]>`select count(*)::int as n from task_step where task_id = ${t}`);
    expect((await count({ employeeId: who }))[0]?.n).toBe(1);
    expect((await count({ employeeId: DEMO_CEO_ID, isCeo: true }))[0]?.n).toBe(1);
    expect((await count({ employeeId: other }))[0]?.n).toBe(0);
  });
});
