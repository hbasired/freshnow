import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import postgres from "postgres";
import { closeDb, logAudit } from "../packages/core/src/index.js";

/**
 * Backups that survive ransomware (TASK-051).
 *
 *   pnpm backup                        dump the database, checksum it, check it can be read back
 *   pnpm backup:verify [file]          checksum + read the archive's table of contents (default: newest)
 *   pnpm backup:restore-test [file]    restore into a scratch database, count rows, drop it
 *
 * Why this shape. Ransomware encrypts what it can reach and, increasingly, steals it first. The
 * answer is not a product but a routine: CISA's ransomware guidance asks for backups that are
 * offline, encrypted and tested [believed — through search]; the industry shorthand is 3-2-1-1-0 —
 * three copies, two kinds of media, one off site, ONE OFFLINE OR IMMUTABLE, ZERO errors on a
 * restore test. This script does the parts a script can do honestly:
 *   - a full, compressed PostgreSQL dump (pg_dump custom format), never a copy of live files;
 *   - a SHA-256 next to it, in `sha256sum` format, so any machine can check a copy was not altered;
 *   - optional encryption with age (open source, filippo.io/age) to a PUBLIC key: this server can
 *     encrypt but never decrypt, so a stolen backup is useless and an attacker on the box cannot
 *     read old ones. The private key lives offline with the CEO, not here;
 *   - a restore test that proves the file brings the data back — a backup never restored is a hope.
 * The offline copy is a person's step: copy backups/ to a USB drive and unplug it, or to storage
 * with object lock. Nothing on this server can make a copy that this server cannot delete.
 *
 * Where pg_dump runs: inside the Supabase database container when it is running (the laptop demo
 * — same version as the server, nothing to install on Windows), else the local pg_dump against
 * DATABASE_URL_SERVICE. Force either with BACKUP_PG_CONTAINER=<name> or BACKUP_PG_CONTAINER=none.
 */

const DIR = resolve(process.env.BACKUP_DIR ?? "backups");
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14) || 14);
const RECIPIENT = process.env.BACKUP_AGE_RECIPIENT?.trim() || null;
const IDENTITY = process.env.BACKUP_AGE_IDENTITY?.trim() || null;
const NAME = /^freshnow-\d{8}T\d{6}Z\.dump(\.age)?$/;
/** Tables whose rows are counted into the manifest; the restore test checks them. */
const KEY_TABLES = ["employee", "task", "task_update", "blocker", "notification_outbox", "audit_log"];

const serviceUrl = process.env.DATABASE_URL_SERVICE;
if (!serviceUrl) {
  console.error("DATABASE_URL_SERVICE is not set — the backup needs the service connection (see .env).");
  process.exit(1);
}
const db = new URL(serviceUrl);
const dbName = decodeURIComponent(db.pathname.replace(/^\//, "")) || "postgres";
const dbUser = decodeURIComponent(db.username) || "postgres";

function container(): string | null {
  const forced = process.env.BACKUP_PG_CONTAINER?.trim();
  if (forced === "none") return null;
  const name = forced || "supabase_db_freshnow";
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim() === "true") return name;
  if (forced) throw new Error(`BACKUP_PG_CONTAINER=${forced} is not a running container.`);
  return null;
}
const CONTAINER = container();

/** A pg_dump / pg_restore command: in the container, or local against the service URL. */
function pgCommand(tool: "pg_dump" | "pg_restore", args: string[], database = dbName): { cmd: string; args: string[] } {
  if (CONTAINER) return { cmd: "docker", args: ["exec", "-i", CONTAINER, tool, "-U", dbUser, ...args, ...(tool === "pg_dump" ? [database] : ["-d", database])] };
  const url = new URL(serviceUrl!);
  url.pathname = `/${database}`;
  return { cmd: tool, args: [...args, tool === "pg_dump" ? url.toString() : `--dbname=${url.toString()}`] };
}

function run(c: { cmd: string; args: string[] }, io: { stdinFile?: string; stdoutFile?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(c.cmd, c.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    if (io.stdoutFile) child.stdout.pipe(createWriteStream(io.stdoutFile, { mode: 0o600 }));
    else child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => fail(new Error(`${c.cmd} could not start: ${e.message}`)));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    if (io.stdinFile) createReadStream(io.stdinFile).pipe(child.stdin);
    else child.stdin.end();
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("error", fail).on("end", () => done(h.digest("hex")));
  });
}

function backups(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => NAME.test(f)).sort().reverse();
}

function pick(arg: string | undefined): string {
  const f = arg ? resolve(arg) : backups()[0] ? join(DIR, backups()[0]!) : null;
  if (!f || !existsSync(f)) throw new Error(arg ? `No such file: ${arg}` : `No backups in ${DIR} — run: pnpm backup`);
  return f;
}

/** Decrypt an .age file to a private temp file (the caller deletes it). */
async function plaintext(file: string): Promise<{ path: string; temp: boolean }> {
  if (!file.endsWith(".age")) return { path: file, temp: false };
  if (!IDENTITY) throw new Error("This backup is encrypted. Set BACKUP_AGE_IDENTITY to the private key file (kept offline) for this check.");
  const out = join(tmpdir(), `freshnow-restore-${process.pid}.dump`);
  const r = await run({ cmd: "age", args: ["-d", "-i", IDENTITY, "-o", out, file] });
  if (r.code !== 0) throw new Error(`age could not decrypt: ${r.stderr.trim()}`);
  return { path: out, temp: true };
}

/** Read the archive's table of contents — proves it is a complete, parseable pg_dump archive. */
async function tableOfContents(dump: string): Promise<{ entries: number; dataFor: string[] }> {
  const r = await run(CONTAINER ? { cmd: "docker", args: ["exec", "-i", CONTAINER, "pg_restore", "--list"] } : { cmd: "pg_restore", args: ["--list"] }, { stdinFile: dump });
  if (r.code !== 0) throw new Error(`pg_restore could not read the archive: ${r.stderr.trim().slice(0, 300)}`);
  const lines = r.stdout.split("\n").filter((l) => /^\d+;/.test(l));
  const dataFor = lines.map((l) => / TABLE DATA public (\S+) /.exec(l)?.[1]).filter((t): t is string => !!t);
  return { entries: lines.length, dataFor };
}

async function counts(sql: postgres.Sql): Promise<Record<string, number>> {
  const present = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public' and table_name = any(${KEY_TABLES})`;
  const out: Record<string, number> = {};
  for (const { table_name } of present) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql("public")}.${sql(table_name)}`;
    out[table_name] = row?.n ?? 0;
  }
  return out;
}

async function backup(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dumpFile = join(DIR, `freshnow-${stamp}.dump`);
  const partial = `${dumpFile}.partial`;

  // Counted just before the dump: the restore test checks the backup holds at least these rows
  // of the append-only audit log (rows added during the dump may or may not be in it).
  const sql = postgres(serviceUrl!, { max: 1, onnotice: () => {} });
  const before = await counts(sql).finally(() => sql.end());

  console.log(`Dumping ${dbName} ${CONTAINER ? `(inside container ${CONTAINER})` : "(local pg_dump)"} …`);
  const d = await run(pgCommand("pg_dump", ["-Fc", "--no-password"]), { stdoutFile: partial });
  if (d.code !== 0) {
    rmSync(partial, { force: true });
    throw new Error(`pg_dump failed: ${d.stderr.trim().slice(0, 500)}`);
  }
  const toc = await tableOfContents(partial);
  const missing = Object.keys(before).filter((t) => !toc.dataFor.includes(t));
  if (missing.length) throw new Error(`The dump has no data section for: ${missing.join(", ")} — not keeping it.`);

  let final = dumpFile;
  if (RECIPIENT) {
    final = `${dumpFile}.age`;
    const e = await run({ cmd: "age", args: ["-r", RECIPIENT, "-o", final, partial] });
    rmSync(partial, { force: true });
    if (e.code !== 0) throw new Error(`age encryption failed (is age installed? winget install FiloSottile.age): ${e.stderr.trim()}`);
  } else {
    renameSync(partial, dumpFile);
  }

  const hex = await sha256(final);
  writeFileSync(`${final}.sha256`, `${hex}  ${basename(final)}\n`);
  const manifest = { file: basename(final), createdAt: new Date().toISOString(), bytes: statSync(final).size, sha256: hex, encrypted: !!RECIPIENT, tocEntries: toc.entries, counts: before, via: CONTAINER ?? "local pg_dump" };
  writeFileSync(`${final}.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  // Keep the newest KEEP; older ones (and their checksum and manifest) go.
  const pruned = backups().slice(KEEP);
  for (const f of pruned) for (const x of [f, `${f}.sha256`, `${f}.json`]) rmSync(join(DIR, x), { force: true });

  await logAudit({ actor: "system", action: "security.backup", entity: "backup", detail: { ...manifest, pruned: pruned.length } });
  console.log(`✓ ${final}\n  ${(manifest.bytes / 1024 / 1024).toFixed(1)} MB · sha256 ${hex.slice(0, 16)}… · ${toc.entries} archive entries · ${manifest.encrypted ? "encrypted (age)" : "NOT encrypted — set BACKUP_AGE_RECIPIENT before copying it off this machine"}`);
  console.log(`  rows: ${Object.entries(before).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  if (pruned.length) console.log(`  removed ${pruned.length} older backup(s); keeping ${KEEP}`);
  console.log("  Next: copy it OFFLINE (USB drive, then unplug) — COMMANDS.md §7e. Then: pnpm backup:restore-test");
}

async function verify(arg: string | undefined): Promise<void> {
  const file = pick(arg);
  const sumFile = `${file}.sha256`;
  if (!existsSync(sumFile)) throw new Error(`No checksum next to ${basename(file)} — cannot tell whether it was altered.`);
  const expected = readFileSync(sumFile, "utf8").split(/\s+/)[0];
  const actual = await sha256(file);
  if (expected !== actual) throw new Error(`CHECKSUM MISMATCH for ${basename(file)} — the file was altered or damaged. Do not restore from it.`);
  console.log(`✓ checksum matches (${actual.slice(0, 16)}…)`);
  const p = await plaintext(file);
  try {
    const toc = await tableOfContents(p.path);
    console.log(`✓ archive readable: ${toc.entries} entries, data for ${toc.dataFor.length} public tables`);
  } finally {
    if (p.temp) rmSync(p.path, { force: true });
  }
}

async function restoreTest(arg: string | undefined): Promise<void> {
  const file = pick(arg);
  await verify(file);
  const manifestFile = `${file}.json`;
  const manifest = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, "utf8")) as { counts?: Record<string, number> }) : {};
  const scratch = "freshnow_restore_check";
  const admin = postgres(serviceUrl!, { max: 1, onnotice: () => {} });
  const p = await plaintext(file);
  let ok = false;
  let restored: Record<string, number> = {};
  let warnings = 0;
  try {
    await admin.unsafe(`drop database if exists ${scratch}`);
    await admin.unsafe(`create database ${scratch}`);
    console.log(`Restoring into a scratch database (${scratch}) …`);
    const r = await run(pgCommand("pg_restore", ["--no-owner", "--no-privileges"], scratch), { stdinFile: p.path });
    // pg_restore exits 1 when it skipped anything (e.g. an extension that already exists); what
    // matters is whether the data came back, which is checked row by row below.
    warnings = (r.stderr.match(/^pg_restore: (error|warning)/gm) ?? []).length;
    const url = new URL(serviceUrl!);
    url.pathname = `/${scratch}`;
    const s = postgres(url.toString(), { max: 1, onnotice: () => {} });
    restored = await counts(s).finally(() => s.end());
    const expected = manifest.counts ?? {};
    const problems = Object.entries(expected).filter(([t, n]) => restored[t] === undefined || (t === "audit_log" ? restored[t]! < n : false));
    ok = problems.length === 0 && Object.keys(restored).length > 0;
    for (const [t, n] of Object.entries(restored)) console.log(`  ${t.padEnd(22)} ${String(n).padStart(8)} rows${expected[t] !== undefined ? `   (manifest: ${expected[t]})` : ""}`);
    if (warnings) console.log(`  pg_restore reported ${warnings} message(s) — usually objects that already exist in the cluster:\n${r.stderr.trim().split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n")}`);
    if (!ok) console.log(`✗ missing or short: ${problems.map(([t]) => t).join(", ") || "no tables restored"}`);
  } finally {
    if (p.temp) rmSync(p.path, { force: true });
    await admin.unsafe(`drop database if exists ${scratch}`).catch(() => {});
    await admin.end();
  }
  await logAudit({ actor: "system", action: "security.restore_test", entity: "backup", detail: { file: basename(file), ok, restored, warnings } });
  if (!ok) throw new Error("Restore test FAILED — this backup would not bring the data back.");
  console.log(`✓ restore test passed — ${basename(file)} brings the data back (scratch database dropped)`);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "verify") await verify(arg);
  else if (cmd === "restore-test") await restoreTest(arg);
  else await backup();
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
