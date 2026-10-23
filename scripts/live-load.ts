/**
 * pnpm live:load — how many live streams one API process carries, measured, not assumed (TASK-058).
 *
 * Starts the API in a CHILD process against the throwaway test database (never the live one), opens
 * N live streams as N different people, and runs three phases:
 *
 *   idle   N streams open, nothing happening — heartbeats only
 *   burst  R single-row writes a second, each to one person's task
 *   org    one change of manager (every viewer's picture is reloaded) while the writes go on
 *
 * It reports the API process's CPU, memory and event-loop delay in each phase; how many change frames
 * reached each kind of viewer, against what ringing everyone (migration 0013) would have sent; and the
 * delay from the database's commit to the frame arriving.
 *
 *   pnpm live:load [--clients 300] [--rate 5] [--seconds 60] [--idle 30] [--out file.json]
 *
 * Needs TEST_DATABASE_URL and TEST_DATABASE_URL_SERVICE pointing at freshnow_test with every migration
 * applied (`pnpm test` does that). Everything it creates is tagged LOAD- and removed at the end.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DEMO_CEO_ID = "00000000-0000-0000-0000-0000000000ce";
const SAMPLE_MS = 250;

// ── The API under test (child process) ──────────────────────────────────────

async function serve(): Promise<void> {
  const { buildServer } = await import("../packages/api/src/server.js");
  const { registerAppShell } = await import("../packages/api/src/routes/app-shell.js");
  const { openLiveStreams } = await import("../packages/api/src/routes/events.js");
  const { liveAudienceStats } = await import("../packages/core/src/index.js");
  const app = buildServer(false);
  // As packages/api/src/index.ts does: the built dashboard at /app, so a browser can be pointed here too.
  await registerAppShell(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();
  let lastElu = performance.eventLoopUtilization();
  setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(lastCpu);
    const elu = performance.eventLoopUtilization(lastElu);
    const m = process.memoryUsage();
    const sample = {
      // CPU time over wall time, as a percentage of ONE core.
      cpuPct: ((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 100,
      rss: m.rss,
      heapUsed: m.heapUsed,
      elu: elu.utilization,
      lagP99Ms: delay.percentile(99) / 1e6,
      lagMaxMs: delay.max / 1e6,
      streams: openLiveStreams(),
      ...liveAudienceStats(),
    };
    lastCpu = process.cpuUsage();
    lastAt = now;
    lastElu = performance.eventLoopUtilization();
    delay.reset();
    process.stdout.write(`SAMPLE ${JSON.stringify(sample)}\n`);
  }, SAMPLE_MS);
  process.stdin.on("data", (d) => {
    if (String(d).includes("gc")) {
      (globalThis as { gc?: () => void }).gc?.();
      process.stdout.write("GC\n");
    }
  });
  process.stdout.write(`READY ${port}\n`);
}

// ── The load (parent process) ───────────────────────────────────────────────

type Kind = "ceo" | "admin" | "supervisor" | "vmo";
type Phase = "baseline" | "connect" | "idle" | "burst" | "org" | "after";
interface Sample {
  phase: Phase;
  at: number;
  cpuPct: number;
  rss: number;
  heapUsed: number;
  elu: number;
  lagP99Ms: number;
  lagMaxMs: number;
  streams: number;
  people: number;
  outOfDate: number;
  loading: number;
}
interface Client {
  id: string;
  kind: Kind;
  greetedMs: number | null;
  status: number | null;
  frames: Record<Phase, number>;
  latencies: number[];
  req?: http.ClientRequest;
}

function args() {
  const a = process.argv.slice(2);
  const num = (name: string, fallback: number) => {
    const i = a.indexOf(`--${name}`);
    const v = i >= 0 ? Number(a[i + 1]) : fallback;
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number`);
    return v;
  };
  const outAt = a.indexOf("--out");
  return {
    clients: Math.round(num("clients", 300)),
    rate: num("rate", 5),
    seconds: num("seconds", 60),
    idle: num("idle", 30),
    out: outAt >= 0 ? a[outAt + 1] : undefined,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : NaN);
const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
const dbName = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));

async function main(): Promise<void> {
  // Here only: the API child gets exactly the environment built for it below, and .env would put
  // back what was taken out (SUPABASE_URL turns sign-in on; the live URLs are the live database).
  await import("dotenv/config");
  const o = args();
  const testUrl = process.env.TEST_DATABASE_URL;
  const testService = process.env.TEST_DATABASE_URL_SERVICE;
  if (!testUrl || !testService) throw new Error("TEST_DATABASE_URL and TEST_DATABASE_URL_SERVICE must be set (see .env.example)");
  for (const u of [testUrl, testService]) {
    if (dbName(u) !== "freshnow_test") throw new Error(`refusing: ${dbName(u)} is not freshnow_test`);
    if (u === process.env.DATABASE_URL || u === process.env.DATABASE_URL_SERVICE) throw new Error("refusing: the test URL is the live database");
  }

  const sql = postgres(testService, { max: 4, onnotice: () => undefined });
  const [where] = await sql<{ db: string }[]>`select current_database() as db`;
  if (where?.db !== "freshnow_test") throw new Error(`refusing: connected to ${where?.db}`);
  // The test setup applies the migration files without recording them, so look for 0027's work itself.
  const [migrated] = await sql<{ n: number }[]>`select count(*)::int as n from pg_trigger where tgname = 'notify_task_ins'`;
  if (!migrated?.n) throw new Error("freshnow_test lacks migration 0027 — run `pnpm test` once first");

  const tag = `LOAD-${randomUUID().slice(0, 6)}`;
  const supervisors = Math.max(1, Math.round(o.clients / 16));
  const vmos = o.clients - 2 - supervisors;
  if (vmos < 1) throw new Error("--clients must be at least 4");
  const admin = randomUUID();
  const sups = Array.from({ length: supervisors }, () => randomUUID());
  const vmoIds = Array.from({ length: vmos }, () => randomUUID());
  const supOf = (i: number) => sups[i % sups.length]!;
  let child: ChildProcess | undefined;
  const clients: Client[] = [];
  const samples: Sample[] = [];
  let phase: Phase = "baseline";

  try {
    // ── seed ──
    type Person = { id: string; name: string; role: string; manager: string };
    const insertPeople = (people: Person[]) => sql`
      insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
      select u.id, ${tag} || '-' || u.name, 'active', true, u.role, u.manager
        from unnest(${people.map((x) => x.id)}::uuid[], ${people.map((x) => x.name)}::text[],
                    ${people.map((x) => x.role)}::text[], ${people.map((x) => x.manager)}::uuid[]) as u (id, name, role, manager)`;
    // Leaders first: a person's manager must exist before them.
    await insertPeople([
      { id: admin, name: "admin", role: "admin", manager: DEMO_CEO_ID },
      ...sups.map((id, i) => ({ id, name: `sup${i}`, role: "supervisor", manager: DEMO_CEO_ID })),
    ]);
    await insertPeople(vmoIds.map((id, i) => ({ id, name: `vmo${i}`, role: "vmo", manager: supOf(i) })));
    const tasks = await sql<{ id: string; employee_id: string }[]>`
      insert into task (employee_id, title, status, is_synthetic)
      select u.id, ${`${tag} round`}, 'open', true from unnest(${vmoIds}::uuid[]) as u (id)
      returning id, employee_id`;

    // ── the database's clock against ours: the best of ten round trips ──
    let offset = 0;
    let bestRtt = Infinity;
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const [db] = await sql<{ ms: string }[]>`select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms`;
      const t1 = Date.now();
      if (db && t1 - t0 < bestRtt) {
        bestRtt = t1 - t0;
        offset = Number(db.ms) - (t0 + t1) / 2;
      }
    }

    // ── the API, in its own process, on the test database, without sign-in (?viewer=) ──
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(SUPABASE_|TELEGRAM_|BOT_TOKEN|CEO_TELEGRAM|SMTP_|EMAIL_|TELEVEND_|LANGFUSE_|OPENROUTER_|NVIDIA_|PUBLIC_URL)/.test(k)) delete env[k];
    }
    env.DATABASE_URL = testUrl;
    env.DATABASE_URL_SERVICE = testService;
    env.LIVE_MAX_STREAMS = String(o.clients + 50);
    const liveRedis = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
    liveRedis.pathname = "/15";
    env.REDIS_URL = process.env.TEST_REDIS_URL ?? liveRedis.href;
    child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), "--serve"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let childErr = "";
    child.stderr!.on("data", (d) => (childErr += String(d)));
    let gcDone: (() => void) | undefined;
    const port = await new Promise<number>((resolve, reject) => {
      let buf = "";
      child!.stdout!.on("data", (d) => {
        buf += String(d);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith("READY ")) resolve(Number(line.slice(6)));
          else if (line.startsWith("SAMPLE ")) samples.push({ phase, at: Date.now(), ...(JSON.parse(line.slice(7)) as Omit<Sample, "phase" | "at">) });
          else if (line === "GC") gcDone?.();
        }
      });
      child!.on("exit", (code) => reject(new Error(`the API process exited (${code}): ${childErr.slice(-2000)}`)));
      setTimeout(() => reject(new Error(`the API process did not start: ${childErr.slice(-2000)}`)), 60_000);
    });
    const gc = () => new Promise<void>((r) => {
      gcDone = r;
      child!.stdin!.write("gc\n");
    });

    // ── baseline ──
    await sleep(2000);
    await gc();
    await sleep(3000);

    // ── connect: everyone at once, as after a restart ──
    phase = "connect";
    const kinds: Array<[string, Kind]> = [[DEMO_CEO_ID, "ceo"], [admin, "admin"], ...sups.map((id): [string, Kind] => [id, "supervisor"]), ...vmoIds.map((id): [string, Kind] => [id, "vmo"])];
    const t0 = Date.now();
    const greeted = Promise.all(
      kinds.map(([id, kind]) => {
        const c: Client = { id, kind, greetedMs: null, status: null, frames: { baseline: 0, connect: 0, idle: 0, burst: 0, org: 0, after: 0 }, latencies: [] };
        clients.push(c);
        return new Promise<void>((resolve, reject) => {
          const req = http.get(
            { host: "127.0.0.1", port, path: `/dashboard/events?viewer=${id}`, agent: false, headers: { accept: "text/event-stream" } },
            (res) => {
              c.status = res.statusCode ?? null;
              if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`stream for ${kind} refused: ${res.statusCode}`));
              }
              res.setEncoding("utf8");
              let buf = "";
              res.on("data", (chunk: string) => {
                buf += chunk;
                const parts = buf.split("\n\n");
                buf = parts.pop() ?? "";
                for (const f of parts) {
                  if (f.startsWith("event: hello")) {
                    c.greetedMs = Date.now() - t0;
                    resolve();
                  } else if (f.startsWith("event: change")) {
                    const data = JSON.parse(f.slice(f.indexOf("data:") + 5)) as { table: string; at: number };
                    c.frames[phase]++;
                    if (phase === "burst" && data.table === "task") c.latencies.push(Date.now() - (data.at - offset));
                  }
                }
              });
              res.on("error", () => undefined);
            },
          );
          req.on("error", reject);
          c.req = req;
        });
      }),
    );
    await Promise.race([greeted, sleep(60_000).then(() => { throw new Error("not every stream was greeted within 60 s"); })]);
    const connectMs = Date.now() - t0;
    await sleep(2000);
    await gc();

    // ── idle ──
    phase = "idle";
    await sleep(o.idle * 1000);

    // ── burst ──
    phase = "burst";
    const writes = Math.round(o.rate * o.seconds);
    const gap = 1000 / o.rate;
    const burstStart = Date.now();
    for (let i = 0; i < writes; i++) {
      const t = tasks[(i * 7919) % tasks.length]!; // spread over everyone, the same every run
      await sql`update task set title = title where id = ${t.id}`;
      const next = burstStart + (i + 1) * gap;
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
    }
    await sleep(1500); // the last frames in flight

    // ── org: one change of manager; every picture is reloaded while writes go on ──
    phase = "org";
    const orgAt = Date.now();
    await sql`update employee set manager_employee_id = ${sups[1 % sups.length]!} where id = ${vmoIds[0]!}`;
    const orgWrites = Math.round(o.rate * 10);
    for (let i = 0; i < orgWrites; i++) {
      await sql`update task set title = title where id = ${tasks[(i * 104729) % tasks.length]!.id}`;
      await sleep(gap);
    }
    await sleep(1500);

    // ── after: everyone leaves ──
    phase = "after";
    for (const c of clients) c.req?.destroy();
    await sleep(3000);
    await gc();
    await sleep(1500);

    // ── report ──
    const of = (p: Phase) => samples.filter((s) => s.phase === p);
    const phaseStats = (p: Phase) => {
      const s = of(p);
      return {
        samples: s.length,
        cpuPctAvg: Math.round(avg(s.map((x) => x.cpuPct)) * 10) / 10,
        cpuPctMax: Math.round(Math.max(...s.map((x) => x.cpuPct)) * 10) / 10,
        eluAvg: Math.round(avg(s.map((x) => x.elu)) * 1000) / 1000,
        lagP99MsMax: Math.round(Math.max(...s.map((x) => x.lagP99Ms)) * 10) / 10,
        rssMbMax: mb(Math.max(...s.map((x) => x.rss))),
        heapMbMax: mb(Math.max(...s.map((x) => x.heapUsed))),
      };
    };
    const lastOf = (p: Phase) => of(p).at(-1)!;
    const orgSamples = of("org");
    const firstCurrent = orgSamples.find((s) => s.at > orgAt + 50 && s.outOfDate === 0);
    const byKind = (k: Kind, p: Phase) => clients.filter((c) => c.kind === k).map((c) => c.frames[p]);
    const latencies = clients.flatMap((c) => c.latencies);
    const delivered = clients.reduce((x, c) => x + c.frames.burst, 0);
    const report = {
      when: new Date().toISOString(),
      machine: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGb: Math.round(os.totalmem() / 1024 ** 3), os: `${os.type()} ${os.release()}`, node: process.version },
      setup: { clients: clients.length, ceo: 1, admin: 1, supervisors, vmos, ratePerSecond: o.rate, burstSeconds: o.seconds, idleSeconds: o.idle, writes },
      connect: { allGreetedMs: connectMs, greetedP50Ms: pct(clients.map((c) => c.greetedMs ?? NaN), 50), greetedP95Ms: pct(clients.map((c) => c.greetedMs ?? NaN), 95) },
      memory: {
        rssMbBefore: mb(lastOf("baseline").rss),
        rssMbWithStreams: mb(of("idle")[0]?.rss ?? NaN),
        heapMbBefore: mb(lastOf("baseline").heapUsed),
        heapMbWithStreams: mb(of("idle")[0]?.heapUsed ?? NaN),
        kbPerStreamRss: Math.round(((of("idle")[0]!.rss - lastOf("baseline").rss) / clients.length / 1024) * 10) / 10,
        kbPerStreamHeap: Math.round(((of("idle")[0]!.heapUsed - lastOf("baseline").heapUsed) / clients.length / 1024) * 10) / 10,
        rssMbAfterLeaving: mb(lastOf("after").rss),
        heapMbAfterLeaving: mb(lastOf("after").heapUsed),
      },
      phases: { baseline: phaseStats("baseline"), idle: phaseStats("idle"), burst: phaseStats("burst"), org: phaseStats("org") },
      frames: {
        burstDelivered: delivered,
        burstIfEveryoneRang: writes * clients.length,
        perKindInBurst: {
          ceo: avg(byKind("ceo", "burst")),
          admin: avg(byKind("admin", "burst")),
          supervisorAvg: Math.round(avg(byKind("supervisor", "burst")) * 10) / 10,
          vmoAvg: Math.round(avg(byKind("vmo", "burst")) * 100) / 100,
          vmoMax: Math.max(...byKind("vmo", "burst")),
        },
        orgPhaseDelivered: clients.reduce((x, c) => x + c.frames.org, 0),
        orgPhaseWrites: orgWrites + 1,
      },
      latencyMs: { p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), p99: Math.round(pct(latencies, 99)), max: Math.round(Math.max(...latencies)), measured: latencies.length, clockRttMs: bestRtt },
      orgReload: { people: lastOf("idle").people, allCurrentAfterMs: firstCurrent ? firstCurrent.at - orgAt : null, sampleMs: SAMPLE_MS },
    };
    console.log(JSON.stringify(report, null, 2));
    if (o.out) writeFileSync(o.out, JSON.stringify({ report, samples }, null, 2));
  } finally {
    for (const c of clients) c.req?.destroy();
    child?.kill();
    await sql`update employee set manager_employee_id = null where display_name like ${`${tag}-%`}`;
    await sql`delete from task where employee_id in (select id from employee where display_name like ${`${tag}-%`})`;
    await sql`delete from employee where display_name like ${`${tag}-%`}`;
    await sql.end();
  }
}

// Last, so every helper above is initialised before either side starts.
if (process.argv.includes("--serve")) await serve();
else await main();
