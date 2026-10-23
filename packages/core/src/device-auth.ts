import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { notifyPeople } from "./alerts.js";
import { logAudit } from "./audit.js";
import { loadConfig } from "./config.js";
import { getServiceSql, type Tx } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import type { ViewerOrg } from "./org.js";
import { can } from "./permissions.js";
import { localDate } from "./time.js";

const scrypt = promisify(scryptCb) as (password: Buffer, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/**
 * Phones, and how people sign in on them (TASK-058, D210). The staff app arrives in TASK-063; this is
 * the half that lives on our side, so the app has something real to talk to.
 *
 *   enrol a phone       the CEO or an Admin creates a one-time code (shown as a QR); the phone trades it
 *                       for its id and a secret it keeps in Android's Keystore. A phone is a custody item.
 *   set up a person     a one-time code — from the CEO, an Admin, or whoever leads the person — lets them
 *                       choose a 4–6 digit PIN on that phone. We give the phone a random secret for them
 *                       (kept in its Keystore) and keep only hashes: of that secret, and of the PIN —
 *                       salted, peppered with a key outside the database, and slow (scrypt).
 *   sign in             the phone sends the person's secret and the PIN they typed; both must match. Only
 *                       this server can tell a right PIN from a wrong one: nothing on the phone lets a
 *                       guess be tested offline, so a shared phone in a colleague's hands, rooted or not,
 *                       gives ten online guesses and no more. Wrong PINs are counted here; from the fifth
 *                       in a row each try waits longer; the tenth disables the credential until the person
 *                       is set up again; twenty in thirty days disable them on every phone. A request
 *                       without the person's own secret is refused before any PIN is counted, so nobody
 *                       can burn another person's attempts from outside their phone.
 *   stay signed in      an opaque 15-minute access token and a refresh token, both hashed here, rotated
 *                       together; a refresh token used twice ends its whole family (RFC 9700 §4.14) —
 *                       except straight after a response that was probably lost on a bad connection. On a
 *                       company phone a sign-in ends at the next shift handover, and after an hour of
 *                       silence; one person at a time is signed in on it.
 *
 * The CEO and Admins sign in only on personal phones. Every step is audited; a person is told when a
 * phone is set up for them and when wrong PINs are entered for them, and so is whoever leads them.
 * Why a server-checked PIN and not a key unlocked on the phone: see D210 (the design review found that a
 * shared phone gives an insider ways to test PINs offline against any device-held key).
 */

export const DEVICE_AUTH = {
  enrolmentMinutes: 10,
  setupCodeHours: 6,
  /** The decision of 2026-10-15 (the approved plan): a 4–6 digit PIN. NIST asks 8+ of a server-checked secret (D210). */
  pinDigits: { min: 4, max: 6 },
  /** Wrong PINs in a row before the credential is disabled. */
  maxFailures: 10,
  /** From the fifth wrong PIN in a row, the wait before the next try, in minutes (5th … 9th). */
  delaysMinutes: [1, 5, 15, 30, 60] as const,
  /** Wrong PINs in 30 days, all phones together, that disable a person everywhere; a good sign-in does not reset it. */
  maxFailuresIn30Days: 20,
  /** Wrong PINs on one phone in an hour, anyone's, that lock the phone for an hour. */
  maxPhoneFailuresPerHour: 15,
  /** Wrong set-up codes on one phone in an hour that lock it for an hour. */
  maxWrongCodesPerHour: 5,
  /** Told to the person and their lead at this many wrong PINs in a row. */
  tellAfterFailures: 3,
  accessMinutes: 15,
  personalSessionDays: 30,
  personalIdleDays: 7,
  /** A rotated refresh token presented again this soon, before its successor was used: a lost response. */
  refreshGraceSeconds: 60,
  /** Expired sessions and old codes are deleted after this long. */
  pruneAfterDays: 30,
} as const;

/** A refusal the API turns into an HTTP status. Messages are for the person holding the phone. */
export class DeviceAuthRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 423 | 429 | 503,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DeviceAuthRefused";
  }
}

// ── Secrets, codes and PINs ───────────────────────────────────────────────────

/** Typed by people: no 0/O or 1/I. 32 symbols, so 5 bits each. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
/** Token prefixes, so a leaked one is recognised for what it is (and by secret scanners). */
const ACCESS_PREFIX = "fna_";
const REFRESH_PREFIX = "fnr_";
const PERSON_PREFIX = "fnp_";

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const random = (): string => randomBytes(32).toString("base64url");

function randomCode(length: number): string {
  // 256 is a multiple of 32, so every symbol is equally likely.
  return [...randomBytes(length)].map((b) => CODE_ALPHABET[b % 32]).join("");
}

/** However it was typed: any case, with or without the dash or spaces. */
const normaliseCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, "");

function pepper(): string {
  const p = loadConfig().APP_PIN_PEPPER;
  if (!p || p.length < 32) throw new DeviceAuthRefused("Phone sign-in is not set up on this server yet.", 503, "not_configured");
  return p;
}
const derived = (info: string): Buffer => Buffer.from(hkdfSync("sha256", pepper(), "freshnow", info, 32));

/** A typed code, hashed with a key derived from the pepper: a copy of the database cannot be used to guess it. */
const codeHash = (code: string): string => createHmac("sha256", derived("device-codes-v1")).update(normaliseCode(code)).digest("hex");

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

// scrypt N=2^14, r=8, p=5: one of OWASP's equivalent minimum settings (Password Storage Cheat Sheet), at
// 16 MiB per lane so a burst of sign-ins at a shift change does not crowd out Postgres.
const SCRYPT = { logN: 14, r: 8, p: 5 } as const;

async function pinDigest(pin: string, salt: Buffer, params: { logN: number; r: number; p: number }): Promise<Buffer> {
  const peppered = createHmac("sha256", derived("pin-pepper-v1")).update(pin).digest();
  return scrypt(peppered, salt, 32, { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 });
}

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await pinDigest(pin, salt, SCRYPT);
  return `scrypt$${SCRYPT.logN}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${h.toString("base64url")}`;
}

async function pinMatches(pin: string, stored: string): Promise<boolean> {
  const [alg, logN, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !logN || !r || !p || !salt || !hash) return false;
  const h = await pinDigest(pin, Buffer.from(salt, "base64url"), { logN: Number(logN), r: Number(r), p: Number(p) });
  const want = Buffer.from(hash, "base64url");
  return h.length === want.length && timingSafeEqual(h, want);
}

const COMMON_PINS = new Set([
  "1234", "1111", "0000", "1212", "7777", "1004", "2000", "4444", "2222", "6969", "9999", "3333", "5555", "6666", "1122",
  "1313", "8888", "4321", "2001", "1010", "2580", "0852", "1230", "0123", "1221", "5683", "0007", "1414", "7890", "1357",
  "123456", "654321", "111111", "000000", "121212", "112233", "123123", "666666", "696969", "159753", "147258", "123321",
  "147852", "789456", "456789", "987654", "102030", "112211", "131313", "159357", "258456", "741852", "963852", "202020",
]);

/** Why a PIN may not be used, or null. The server sees the PIN, so the rules hold whatever the app checks. */
export function pinRefusal(pin: string): string | null {
  const { min, max } = DEVICE_AUTH.pinDigits;
  if (!/^\d+$/.test(pin)) return "A PIN is digits only.";
  if (pin.length < min || pin.length > max) return `Choose ${min} to ${max} digits.`;
  if (/^(\d)\1+$/.test(pin)) return "Not the same digit over and over.";
  if ("01234567890".includes(pin) || "09876543210".includes(pin)) return "Not a run of digits like 1234.";
  if (COMMON_PINS.has(pin)) return "That PIN is too common. Choose another.";
  const half = pin.length / 2;
  if (pin.length % 2 === 0 && pin.slice(0, half) === pin.slice(half)) return "Not a pattern that repeats.";
  if (pin.length === 4 && /^(19[4-9]\d|20[0-4]\d)$/.test(pin)) return "Not a year. Years are easy to guess.";
  const dm = (d: string, m: string) => Number(d) >= 1 && Number(d) <= 31 && Number(m) >= 1 && Number(m) <= 12;
  if (pin.length === 4 && (dm(pin.slice(0, 2), pin.slice(2)) || dm(pin.slice(2), pin.slice(0, 2)))) {
    return "Not a date. Dates are easy to guess.";
  }
  if (pin.length === 6 && (dm(pin.slice(0, 2), pin.slice(2, 4)) || dm(pin.slice(2, 4), pin.slice(0, 2)))) {
    return "Not a date. Dates are easy to guess.";
  }
  return null;
}

// ── Who may do what ───────────────────────────────────────────────────────────

/** The CEO's and Admins' own sign-in is the CEO's to set up or end — or their own (as their email address, D201). */
function guardedTarget(t: { id: string; access_role: string }): boolean {
  return t.id === DEMO_CEO_ID || t.access_role === "ceo" || t.access_role === "admin";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** audit_log.correlation_id is a uuid: anything else would make the audit write fail after the work (review #2). */
const correlationOf = (c?: string): string => (c && UUID_RE.test(c) ? c : randomUUID());
/** The same for the tables' own correlation_id columns (uuid): a malformed id is dropped, never fatal. */
const uuidOrNull = (c?: string): string | null => (c && UUID_RE.test(c) ? c : null);

type AuditFields = { actor: string; entity: string; entityId?: string; detail?: Record<string, unknown>; correlationId?: string };

async function audit(action: string, p: AuditFields) {
  await logAudit({
    correlationId: correlationOf(p.correlationId),
    actor: p.actor,
    action,
    entity: p.entity,
    ...(p.entityId ? { entityId: p.entityId } : {}),
    ...(p.detail ? { detail: p.detail } : {}),
  });
}

/**
 * The same row, written in the caller's transaction. For the rows the limits COUNT (wrong PINs, wrong
 * codes): written after commit they could be lost — and with them the count — while the change they
 * count was already made (TASK-058 review #2).
 */
async function auditIn(tx: Tx, action: string, p: AuditFields): Promise<void> {
  await tx`
    insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
    values (${correlationOf(p.correlationId)}, ${p.actor}, ${action}, ${p.entity}, ${p.entityId ?? null},
            ${p.detail ? tx.json(p.detail as never) : null})`;
}

/** One attempt at a time per phone: counting its failures and writing one happen together (review #2, #5). */
async function lockPhone(tx: Tx, deviceId: string): Promise<void> {
  await tx`select 1 from device where id = ${deviceId} for update`;
}

/** "Kiran Sharma" → "Kiran S." — enough to find yourself on a shared phone, no more. */
export function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]!.charAt(0)}.` : (parts[0] ?? "");
}

// ── When a sign-in ends ───────────────────────────────────────────────────────

/** HH:MM in Asia/Dubai, from APP_SHIFT_HANDOVERS. UNVERIFIED: FreshNow's real handover times (A-T58.4). */
export function shiftHandovers(): string[] {
  const raw = loadConfig().APP_SHIFT_HANDOVERS ?? "07:30,15:00";
  const list = raw.split(",").map((s) => s.trim()).filter((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
  return list.length > 0 ? list : ["07:30", "15:00"];
}

/**
 * A company phone's sign-in ends at the first shift handover at least two hours after it began, plus
 * half an hour: the night driver who signs in at 14:40 keeps it until 08:00 the next morning, the day
 * driver who signs in at 07:20 until 15:30. The next person signs in for themselves.
 */
export function companySessionEnd(signedInAt: Date, times: readonly string[] = shiftHandovers(), graceMinutes = 30, minHours = 2): Date {
  const earliest = signedInAt.getTime() + minHours * 3_600_000;
  const day0 = localDate(signedInAt);
  let best = Infinity;
  for (let offset = 0; offset <= 2; offset++) {
    const day = localDate(new Date(Date.parse(`${day0}T12:00:00+04:00`) + offset * 86_400_000));
    for (const t of times) {
      const at = Date.parse(`${day}T${t}:00+04:00`); // Dubai has no daylight saving
      if (at >= earliest && at < best) best = at;
    }
  }
  return new Date(best + graceMinutes * 60_000);
}

function companyIdleMinutes(): number {
  return loadConfig().APP_COMPANY_IDLE_MINUTES ?? 60;
}

// ── Enrolment: a phone becomes a known phone ──────────────────────────────────

export async function createEnrolment(p: {
  actor: ViewerOrg;
  kind: "company" | "personal";
  label: string;
  employeeId?: string | null;
  correlationId?: string;
}): Promise<{ enrolmentId: string; code: string; expiresAt: string }> {
  if (!can(p.actor, "people.manage")) throw new DeviceAuthRefused("Only the CEO or an Admin enrols phones.", 403, "forbidden");
  const label = p.label.trim();
  if (label.length < 1 || label.length > 80) throw new DeviceAuthRefused("Give the phone a name of 1–80 characters.", 400, "bad_label");
  const sql = getServiceSql();
  let bound: string | null = null;
  if (p.kind === "personal") {
    const [e] = await sql<{ id: string; status: string }[]>`select id, status from employee where id = ${p.employeeId ?? null}`;
    if (!e || e.status !== "active") throw new DeviceAuthRefused("A personal phone needs the active person it belongs to.", 400, "bad_person");
    bound = e.id;
  }
  const code = randomCode(20); // 100 bits; it travels as a QR, not by hand
  const [row] = await sql<{ id: string; expires_at: Date }[]>`
    insert into device_enrolment (code_hash, kind, label, bound_employee_id, created_by, expires_at, correlation_id)
    values (${codeHash(code)}, ${p.kind}, ${label}, ${bound}, ${p.actor.employeeId},
            now() + make_interval(mins => ${DEVICE_AUTH.enrolmentMinutes}), ${uuidOrNull(p.correlationId)})
    returning id, expires_at`;
  await audit("device.enrolment_created", {
    actor: `employee:${p.actor.employeeId}`,
    entity: "device_enrolment",
    entityId: row!.id,
    detail: { kind: p.kind, label, boundEmployeeId: bound },
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  return { enrolmentId: row!.id, code, expiresAt: row!.expires_at.toISOString() };
}

export interface EnrolledDevice {
  deviceId: string;
  /** Shown to the phone once; we keep only its hash. */
  deviceSecret: string;
  kind: "company" | "personal";
  label: string;
}

export async function enrolDevice(p: { code: string; platform?: string; model?: string; appVersion?: string; correlationId?: string }): Promise<EnrolledDevice> {
  const hash = codeHash(p.code);
  const deviceSecret = random();
  const out = await getServiceSql().begin(async (tx) => {
    const [e] = await tx<{ id: string; kind: "company" | "personal"; label: string; bound_employee_id: string | null; created_by: string; used_at: Date | null; expires_at: Date; device_id: string | null }[]>`
      select id, kind, label, bound_employee_id, created_by, used_at, expires_at, device_id from device_enrolment
       where code_hash = ${hash} for update`;
    if (!e || e.expires_at <= new Date()) return { refused: true as const };
    if (e.used_at) {
      // A code used twice means it was seen by someone else (a photo of the QR): the phone it made goes too.
      if (e.device_id) {
        await tx`update device set revoked_at = now(), revoke_reason = 'its enrolment code was used again' where id = ${e.device_id} and revoked_at is null`;
        await revokeSessionsOfDevice(tx, e.device_id, "its enrolment code was used again");
      }
      return { refused: true as const, reused: e.device_id };
    }
    const [d] = await tx<{ id: string }[]>`
      insert into device (kind, label, bound_employee_id, platform, model, app_version, secret_hash, enrolled_by, correlation_id)
      values (${e.kind}, ${e.label}, ${e.bound_employee_id}, ${clip(p.platform)}, ${clip(p.model)}, ${clip(p.appVersion)},
              ${sha256(deviceSecret)}, ${e.created_by}, ${uuidOrNull(p.correlationId)})
      returning id`;
    await tx`update device_enrolment set used_at = now(), device_id = ${d!.id} where id = ${e.id}`;
    return { deviceId: d!.id, kind: e.kind, label: e.label };
  });
  if ("refused" in out) {
    if (out.reused) {
      await audit("device.enrolment_code_reused", { actor: "system", entity: "device", entityId: out.reused, detail: { revoked: true } });
    }
    // Unknown, expired and used codes get one answer: there is nothing to learn from it.
    throw new DeviceAuthRefused("This code has expired or was already used. Ask for a new one.", 401, "bad_code");
  }
  await audit("device.enrolled", {
    actor: `device:${out.deviceId}`,
    entity: "device",
    entityId: out.deviceId,
    detail: { kind: out.kind, label: out.label, platform: clip(p.platform), model: clip(p.model) },
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  return { ...out, deviceSecret };
}

const clip = (s: string | undefined): string | null => (s ? s.slice(0, 80) : null);

interface DeviceRow {
  id: string;
  kind: "company" | "personal";
  label: string;
  bound_employee_id: string | null;
}

/** The phone proves it is an enrolled phone, not switched off and not locked. */
async function knownDevice(tx: Tx, deviceId: string, deviceSecret: string): Promise<DeviceRow> {
  if (!/^[0-9a-f-]{36}$/i.test(deviceId)) throw new DeviceAuthRefused("This phone is not enrolled.", 401, "unknown_device");
  const [d] = await tx<(DeviceRow & { secret_hash: string; revoked_at: Date | null; locked_until: Date | null })[]>`
    select id, kind, label, bound_employee_id, secret_hash, revoked_at, locked_until from device where id = ${deviceId}`;
  if (!d || !sameHex(d.secret_hash, sha256(deviceSecret))) throw new DeviceAuthRefused("This phone is not enrolled.", 401, "unknown_device");
  if (d.revoked_at) throw new DeviceAuthRefused("This phone has been switched off. Hand it to your supervisor.", 401, "device_revoked");
  if (d.locked_until && d.locked_until > new Date()) {
    const minutes = Math.max(1, Math.ceil((d.locked_until.getTime() - Date.now()) / 60_000));
    throw new DeviceAuthRefused(`Too many wrong tries on this phone. Try again in ${minutes} minutes.`, 429, "phone_locked", {
      retryAfterSeconds: Math.ceil((d.locked_until.getTime() - Date.now()) / 1000),
    });
  }
  // Seen at most once a minute: a busy phone should not write on every call.
  await tx`update device set last_seen_at = now() where id = ${d.id} and (last_seen_at is null or last_seen_at < now() - interval '1 minute')`;
  return { id: d.id, kind: d.kind, label: d.label, bound_employee_id: d.bound_employee_id };
}

async function revokeSessionsOfDevice(tx: Tx, deviceId: string, reason: string): Promise<void> {
  await tx`update app_credential set revoked_at = now() where device_id = ${deviceId} and revoked_at is null`;
  await tx`update app_session set revoked_at = now(), revoke_reason = ${reason} where device_id = ${deviceId} and revoked_at is null`;
}

/** Recent audit rows for this phone, for the phone-wide limits (the audit log is the counter, as in rate-limit.ts). */
async function recentOnPhone(tx: Tx, action: string, deviceId: string, minutes: number): Promise<number> {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from audit_log
     where action = ${action} and detail ->> 'deviceId' = ${deviceId} and created_at > now() - make_interval(mins => ${minutes})`;
  return r?.n ?? 0;
}

// ── Setting a person up on a phone ────────────────────────────────────────────

export async function issueSetupCode(p: { actor: ViewerOrg; employeeId: string; correlationId?: string }): Promise<{ code: string; expiresAt: string }> {
  const sql = getServiceSql();
  const [t] = await sql<{ id: string; status: string; access_role: string; manager_employee_id: string | null }[]>`
    select id, status, access_role, manager_employee_id from employee where id = ${p.employeeId}`;
  if (!t || t.status !== "active") throw new DeviceAuthRefused("Only an active person can be set up.", 400, "bad_person");
  const self = t.id === p.actor.employeeId;
  const leads = can(p.actor, "people.view_reports") && t.manager_employee_id === p.actor.employeeId;
  if (!self && !leads && !can(p.actor, "people.manage")) {
    throw new DeviceAuthRefused("Only the CEO, an Admin or the person's own lead can set up their phone sign-in.", 403, "forbidden");
  }
  if (guardedTarget(t) && !self && !p.actor.isCeo) {
    throw new DeviceAuthRefused("The CEO's and Admins' phone sign-in is set up by the CEO or by themselves.", 403, "forbidden");
  }
  const code = randomCode(10); // 50 bits, typed by hand as XXXXX-XXXXX
  const [row] = await sql.begin(async (tx) => {
    await tx`update app_setup_code set voided_at = now() where employee_id = ${t.id} and used_at is null and voided_at is null`;
    return tx<{ id: string; expires_at: Date }[]>`
      insert into app_setup_code (employee_id, code_hash, created_by, expires_at, correlation_id)
      values (${t.id}, ${codeHash(code)}, ${p.actor.employeeId}, now() + make_interval(hours => ${DEVICE_AUTH.setupCodeHours}), ${uuidOrNull(p.correlationId)})
      returning id, expires_at`;
  });
  await audit("app.setup_code_issued", {
    actor: `employee:${p.actor.employeeId}`,
    entity: "employee",
    entityId: t.id,
    detail: { setupCodeId: row!.id },
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt: row!.expires_at.toISOString() };
}

export async function bindCredential(p: {
  deviceId: string;
  deviceSecret: string;
  setupCode: string;
  pin: string;
  correlationId?: string;
}): Promise<{ credentialId: string; employeeId: string; displayName: string; personSecret: string }> {
  const bad = pinRefusal(p.pin);
  if (bad) throw new DeviceAuthRefused(bad, 400, "weak_pin");
  const hash = codeHash(p.setupCode);
  const personSecret = `${PERSON_PREFIX}${random()}`;
  // Check the phone and the code BEFORE the slow PIN hash: hashing first let anyone with a made-up
  // phone id keep the hashing threads busy (TASK-058 review #7). The transaction below checks again.
  const codeLooksGood = await getServiceSql().begin(async (tx) => {
    await knownDevice(tx, p.deviceId, p.deviceSecret);
    const [c] = await tx<{ id: string }[]>`
      select id from app_setup_code where code_hash = ${hash} and used_at is null and voided_at is null and expires_at > now()`;
    return c !== undefined;
  });
  const pinHash = codeLooksGood ? await hashPin(p.pin) : null;
  const r = await getServiceSql().begin(async (tx) => {
    const d = await knownDevice(tx, p.deviceId, p.deviceSecret);
    await lockPhone(tx, d.id);
    const [c] = await tx<{ id: string; employee_id: string }[]>`
      select id, employee_id from app_setup_code
       where code_hash = ${hash} and used_at is null and voided_at is null and expires_at > now()
       for update`;
    if (!c || pinHash === null) {
      // Wrong codes on one phone are counted — the row written here, with the count; past the limit the
      // phone is locked an hour.
      const wrong = (await recentOnPhone(tx, "app.setup_code_refused", d.id, 60)) + 1;
      if (wrong >= DEVICE_AUTH.maxWrongCodesPerHour) await tx`update device set locked_until = now() + interval '1 hour' where id = ${d.id}`;
      await auditIn(tx, "app.setup_code_refused", {
        actor: `device:${d.id}`,
        entity: "device",
        entityId: d.id,
        detail: { deviceId: d.id, wrongInLastHour: wrong },
        ...(p.correlationId ? { correlationId: p.correlationId } : {}),
      });
      return { refused: "code" as const, deviceId: d.id, wrong };
    }
    const [e] = await tx<{ id: string; display_name: string; status: string; access_role: string }[]>`
      select id, display_name, status, access_role from employee where id = ${c.employee_id}`;
    if (!e || e.status !== "active") return { refused: "person" as const };
    if (d.kind === "personal" && d.bound_employee_id !== e.id) return { refused: "theirs" as const };
    // A shared phone is in many hands; the CEO's and Admins' sign-in lives only on their own phones.
    if (d.kind === "company" && guardedTarget(e)) return { refused: "guarded" as const };
    // Set up again on the same phone: the old credential and its sessions end.
    const old = await tx<{ id: string }[]>`
      update app_credential set revoked_at = now() where device_id = ${d.id} and employee_id = ${e.id} and revoked_at is null returning id`;
    if (old.length > 0) {
      await tx`update app_session set revoked_at = now(), revoke_reason = 'set up again'
                where credential_id = any(${old.map((o) => o.id)}) and revoked_at is null`;
    }
    const [cred] = await tx<{ id: string }[]>`
      insert into app_credential (device_id, employee_id, secret_hash, pin_hash, setup_code_id, correlation_id)
      values (${d.id}, ${e.id}, ${sha256(personSecret)}, ${pinHash}, ${c.id}, ${uuidOrNull(p.correlationId)}) returning id`;
    await tx`update app_setup_code set used_at = now(), used_on_device = ${d.id} where id = ${c.id}`;
    return { credentialId: cred!.id, employeeId: e.id, displayName: e.display_name, deviceId: d.id, label: d.label, replaced: old.length };
  });
  if ("refused" in r) {
    if (r.refused === "code") {
      throw new DeviceAuthRefused("This set-up code has expired or was already used. Ask for a new one.", 401, "bad_code");
    }
    if (r.refused === "theirs") throw new DeviceAuthRefused("This phone belongs to someone else.", 403, "not_your_phone");
    if (r.refused === "guarded") throw new DeviceAuthRefused("The CEO and Admins sign in on their own phone, not a shared one.", 403, "shared_phone");
    throw new DeviceAuthRefused("This person can no longer sign in.", 403, "inactive");
  }
  await audit("app.credential_bound", {
    actor: `device:${r.deviceId}`,
    entity: "app_credential",
    entityId: r.credentialId,
    detail: { employeeId: r.employeeId, deviceId: r.deviceId, replaced: r.replaced },
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  await tell({
    to: [{ employeeId: r.employeeId, reason: "your phone sign-in" }],
    key: `security.phone_set_up:${r.credentialId}`,
    text: `A phone was set up for you to sign in: ${r.label}. If this was not you, tell your supervisor now.`,
    title: "Phone sign-in set up",
    urgent: false,
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  return { credentialId: r.credentialId, employeeId: r.employeeId, displayName: r.displayName, personSecret };
}

/** A security notice through the outbox — the person, and when asked whoever leads them. Never fails the caller. */
async function tell(p: { to: { employeeId: string; reason: string }[]; key: string; text: string; title: string; urgent: boolean; correlationId?: string }) {
  try {
    await notifyPeople({
      recipients: p.to,
      keyFor: (employeeId, channel) => `${p.key}:${employeeId}:${channel}`,
      text: p.text,
      kind: p.key.split(":")[0]!,
      presentation: { title: p.title, url: "/app/", tag: p.key, urgent: p.urgent },
      ...(p.correlationId ? { correlationId: p.correlationId } : {}),
    });
  } catch {
    /* the notice is a courtesy; the audit row above is the record */
  }
}

/** The people set up on this phone, for "tap your name": short names only, active and not disabled. */
export async function devicePeople(p: { deviceId: string; deviceSecret: string }): Promise<{ employeeId: string; name: string; waiting: boolean }[]> {
  return getServiceSql().begin(async (tx) => {
    const d = await knownDevice(tx, p.deviceId, p.deviceSecret);
    const rows = await tx<{ employee_id: string; display_name: string; waiting: boolean }[]>`
      select c.employee_id, e.display_name, (c.locked_until is not null and c.locked_until > now()) as waiting
        from app_credential c join employee e on e.id = c.employee_id
       where c.device_id = ${d.id} and c.revoked_at is null and c.disabled_at is null and e.status = 'active'
       order by e.display_name`;
    return rows.map((r) => ({ employeeId: r.employee_id, name: shortName(r.display_name), waiting: r.waiting }));
  });
}

// ── Signing in ────────────────────────────────────────────────────────────────

interface CredentialRow {
  id: string;
  employee_id: string;
  secret_hash: string;
  pin_hash: string;
  failed_count: number;
  locked_until: Date | null;
  disabled_at: Date | null;
}

function refusalFor(c: CredentialRow, now: Date): DeviceAuthRefused | null {
  if (c.disabled_at) return new DeviceAuthRefused("Too many wrong PINs. Ask your supervisor for a new set-up code.", 423, "disabled");
  if (c.locked_until && c.locked_until > now) {
    const minutes = Math.max(1, Math.ceil((c.locked_until.getTime() - now.getTime()) / 60_000));
    return new DeviceAuthRefused(`Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, 429, "slowed", {
      retryAfterSeconds: Math.ceil((c.locked_until.getTime() - now.getTime()) / 1000),
    });
  }
  return null;
}

export interface AppTokens {
  sessionId: string;
  employeeId: string;
  deviceId: string;
  /** Shown to the phone once; we keep only hashes. */
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  /** When this sign-in ends however often it is refreshed. */
  expiresAt: string;
}

const accessExpiry = (): Date => new Date(Date.now() + DEVICE_AUTH.accessMinutes * 60_000);

async function newPair(
  tx: Tx,
  p: { familyId: string; credentialId: string; deviceId: string; employeeId: string; expiresAt: Date; idleUntil: Date; correlationId?: string },
): Promise<AppTokens> {
  const access = `${ACCESS_PREFIX}${random()}`;
  const refresh = `${REFRESH_PREFIX}${random()}`;
  const accessExpiresAt = new Date(Math.min(accessExpiry().getTime(), p.expiresAt.getTime()));
  const [s] = await tx<{ id: string }[]>`
    insert into app_session (family_id, credential_id, device_id, employee_id, access_hash, access_expires_at, refresh_hash,
                             expires_at, idle_until, correlation_id)
    values (${p.familyId}, ${p.credentialId}, ${p.deviceId}, ${p.employeeId}, ${sha256(access)}, ${accessExpiresAt}, ${sha256(refresh)},
            ${p.expiresAt}, ${p.idleUntil}, ${uuidOrNull(p.correlationId)})
    returning id`;
  return {
    sessionId: s!.id,
    employeeId: p.employeeId,
    deviceId: p.deviceId,
    accessToken: access,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshToken: refresh,
    expiresAt: p.expiresAt.toISOString(),
  };
}

interface Verified {
  device: DeviceRow;
  credentialId: string;
  employeeId: string;
  /** Wrong PINs in a row before this good one — shown to the person: "2 wrong PINs since you last signed in". */
  failedBefore: number;
}

/**
 * Is this the person, on this phone? Their own secret from this phone, then the PIN. Every wrong PIN is
 * counted the same way, whatever the request was for (a sign-in or a PIN change). A good PIN clears the
 * run of wrong ones — but not the 30-day count, which only time clears.
 */
async function verifyPersonPin(p: { deviceId: string; deviceSecret: string; employeeId: string; personSecret: string; pin: string; correlationId?: string }): Promise<Verified> {
  const sql = getServiceSql();
  // Read first and check the PIN outside any lock: scrypt is slow on purpose, and a row lock held
  // through it would queue everyone else's sign-in on that phone.
  const pre = await sql.begin(async (tx) => {
    const d = await knownDevice(tx, p.deviceId, p.deviceSecret);
    const [c] = await tx<(CredentialRow & { status: string; access_role: string })[]>`
      select c.id, c.employee_id, c.secret_hash, c.pin_hash, c.failed_count, c.locked_until, c.disabled_at, e.status, e.access_role
        from app_credential c join employee e on e.id = c.employee_id
       where c.device_id = ${d.id} and c.employee_id = ${p.employeeId} and c.revoked_at is null`;
    return { d, c };
  });
  const d = pre.d;
  const c0 = pre.c;
  if (!c0) throw new DeviceAuthRefused("Set up sign-in on this phone first.", 404, "not_set_up");
  // Without this person's own secret from this phone no PIN is even looked at, so nobody can burn
  // another person's attempts from outside their phone.
  if (!sameHex(c0.secret_hash, sha256(p.personSecret))) throw new DeviceAuthRefused("Set up sign-in on this phone again.", 401, "bad_person_secret");
  if (c0.status !== "active") throw new DeviceAuthRefused("This person can no longer sign in.", 403, "inactive");
  // Checked at every sign-in, not only at set-up: someone made Admin since keeps no shared-phone sign-in (review #6).
  if (d.kind === "company" && guardedTarget({ id: c0.employee_id, access_role: c0.access_role })) {
    throw new DeviceAuthRefused("The CEO and Admins sign in on their own phone, not a shared one.", 403, "shared_phone");
  }
  const early = refusalFor(c0, new Date());
  if (early) throw early;
  const good = /^\d{1,12}$/.test(p.pin) && (await pinMatches(p.pin, c0.pin_hash));

  const r = await sql.begin(async (tx) => {
    await lockPhone(tx, d.id);
    const [c] = await tx<CredentialRow[]>`
      select id, employee_id, secret_hash, pin_hash, failed_count, locked_until, disabled_at from app_credential
       where id = ${c0.id} and revoked_at is null for update`;
    if (!c) return { refused: new DeviceAuthRefused("Set up sign-in on this phone first.", 404, "not_set_up") };
    // Another attempt may have finished while this PIN was checked: decide on the row as it is now.
    const late = refusalFor(c, new Date());
    if (late) return { refused: late };
    // The PIN changed while this one was being checked: the old one must not get in once more (review #10).
    // Not counted — the person typed what was their PIN a moment ago.
    if (c.pin_hash !== c0.pin_hash) return { refused: new DeviceAuthRefused("Your PIN was just changed. Try again with the new one.", 409, "pin_changed") };
    if (good) {
      await tx`update app_credential set failed_count = 0, locked_until = null where id = ${c.id}`;
      return { ok: { credentialId: c.id, employeeId: c.employee_id, failedBefore: c.failed_count } };
    }
    const failures = c.failed_count + 1;
    const in30 = (await recentPersonFailures(tx, c.employee_id)) + 1;
    const onPhone = (await recentOnPhone(tx, "app.sign_in_failed", d.id, 60)) + 1;
    const why =
      failures >= DEVICE_AUTH.maxFailures
        ? `${failures} wrong PINs in a row`
        : in30 >= DEVICE_AUTH.maxFailuresIn30Days
          ? `${in30} wrong PINs in 30 days`
          : null;
    const delay = !why && failures >= 5 ? DEVICE_AUTH.delaysMinutes[Math.min(failures - 5, DEVICE_AUTH.delaysMinutes.length - 1)]! : 0;
    await tx`
      update app_credential set failed_count = ${failures}, last_failed_at = now(),
             locked_until = ${delay > 0 ? new Date(Date.now() + delay * 60_000) : null},
             disabled_at = ${why ? new Date() : null}, disabled_reason = ${why}
       where id = ${c.id}`;
    if (in30 >= DEVICE_AUTH.maxFailuresIn30Days) {
      // Slow guessing across phones and weeks: every sign-in the person has ENDS, on every phone, so the
      // only way back is a fresh set-up — whose new credentials the old guesses no longer count against
      // (review #9: the old rule restarted the count at any set-up, forgiving guesses at PINs not changed).
      await tx`update app_credential set revoked_at = now(), disabled_at = coalesce(disabled_at, now()),
                      disabled_reason = coalesce(disabled_reason, ${`${in30} wrong PINs in 30 days`})
                where employee_id = ${c.employee_id} and revoked_at is null`;
      await tx`update app_session set revoked_at = now(), revoke_reason = 'too many wrong PINs'
                where employee_id = ${c.employee_id} and revoked_at is null`;
    }
    const phoneLocked = onPhone >= DEVICE_AUTH.maxPhoneFailuresPerHour;
    if (phoneLocked) await tx`update device set locked_until = now() + interval '1 hour' where id = ${d.id}`;
    // Every wrong PIN is one of these rows, written WITH the count it adds to: the phone's hourly limit and
    // the 30-day window count them, so they must not be lost after the failure was recorded (review #2).
    await auditIn(tx, "app.sign_in_failed", {
      actor: `device:${d.id}`,
      entity: "app_credential",
      entityId: c.id,
      detail: { employeeId: c.employee_id, deviceId: d.id, failures, in30Days: in30, waitMinutes: delay, phoneLocked },
      ...(p.correlationId ? { correlationId: p.correlationId } : {}),
    });
    if (why) {
      await auditIn(tx, "app.credential_disabled", {
        actor: `device:${d.id}`,
        entity: "app_credential",
        entityId: c.id,
        detail: { employeeId: c.employee_id, deviceId: d.id, reason: why },
        ...(p.correlationId ? { correlationId: p.correlationId } : {}),
      });
    }
    return { failed: { credentialId: c.id, employeeId: c.employee_id, failures, in30, why, delay, phoneLocked } };
  });

  if ("failed" in r && r.failed) {
    const f = r.failed;
    if (f.failures === DEVICE_AUTH.tellAfterFailures || f.why) {
      const lead = await leadOf(f.employeeId);
      const name = await nameOf(f.employeeId);
      await tell({
        to: [{ employeeId: f.employeeId, reason: "your phone sign-in" }, ...(lead ? [{ employeeId: lead, reason: "someone you lead" }] : [])],
        key: `security.${f.why ? "sign_in_stopped" : "wrong_pins"}:${f.credentialId}:${f.failures}:${f.in30}`,
        text: f.why
          ? `Phone sign-in for ${name} on ${d.label} was stopped after ${f.why}. Their lead can give them a new set-up code.`
          : `${f.failures} wrong PINs in a row for ${name} on ${d.label}. If this was not them, tell their supervisor.`,
        title: f.why ? "Phone sign-in stopped" : "Wrong PINs entered",
        urgent: true,
        ...(p.correlationId ? { correlationId: p.correlationId } : {}),
      });
    }
    if (f.why) throw new DeviceAuthRefused("Too many wrong PINs. Ask your supervisor for a new set-up code.", 423, "disabled");
    throw new DeviceAuthRefused(f.delay > 0 ? `Wrong PIN. Try again in ${f.delay} minute${f.delay === 1 ? "" : "s"}.` : "Wrong PIN.", 401, "wrong_pin", {
      attemptsLeft: DEVICE_AUTH.maxFailures - f.failures,
      ...(f.delay > 0 ? { retryAfterSeconds: f.delay * 60 } : {}),
    });
  }
  if ("refused" in r && r.refused) throw r.refused;
  const ok = (r as { ok: Omit<Verified, "device"> }).ok;
  return { device: d, ...ok };
}

export async function signIn(p: {
  deviceId: string;
  deviceSecret: string;
  employeeId: string;
  personSecret: string;
  pin: string;
  correlationId?: string;
}): Promise<AppTokens & { failedSinceLastSignIn: number }> {
  const v = await verifyPersonPin(p);
  const d = v.device;
  const r = await getServiceSql().begin(async (tx) => {
    // Serialised with a refresh in flight on this phone, so the sign-out below also reaches the pair
    // that refresh is creating (review #5).
    await lockPhone(tx, d.id);
    await tx`update app_credential set last_signed_in_at = now() where id = ${v.credentialId}`;
    // One person at a time on a shared phone: whoever was signed in on it is signed out.
    const ended =
      d.kind === "company"
        ? await tx`update app_session set revoked_at = now(), revoke_reason = 'another person signed in on this phone' where device_id = ${d.id} and revoked_at is null`
        : { count: 0 };
    const now = new Date();
    const expiresAt = d.kind === "company" ? companySessionEnd(now) : new Date(now.getTime() + DEVICE_AUTH.personalSessionDays * 86_400_000);
    const idleMs = d.kind === "company" ? companyIdleMinutes() * 60_000 : DEVICE_AUTH.personalIdleDays * 86_400_000;
    const tokens = await newPair(tx, {
      familyId: randomUUID(),
      credentialId: v.credentialId,
      deviceId: d.id,
      employeeId: v.employeeId,
      expiresAt,
      idleUntil: new Date(Math.min(expiresAt.getTime(), now.getTime() + idleMs)),
      ...(p.correlationId ? { correlationId: p.correlationId } : {}),
    });
    return { tokens, ended: ended.count };
  });
  await audit("app.signed_in", {
    actor: `employee:${v.employeeId}`,
    entity: "app_session",
    entityId: r.tokens.sessionId,
    detail: { deviceId: d.id, endedOthers: r.ended, failedBefore: v.failedBefore },
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  return { ...r.tokens, failedSinceLastSignIn: v.failedBefore };
}

/**
 * Wrong PINs in the last 30 days against the sign-ins this person still has, on every phone. A set-up
 * gives a NEW credential (and a new PIN), so guesses at an old one stop counting once it is revoked —
 * but a set-up on another phone no longer forgives guesses at PINs it did not change (review #9). When
 * the limit is reached every one of the person's credentials is revoked, so recovery starts clean.
 */
async function recentPersonFailures(tx: Tx, employeeId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from audit_log
     where action = 'app.sign_in_failed' and entity = 'app_credential'
       and entity_id in (select id::text from app_credential where employee_id = ${employeeId} and revoked_at is null)
       and created_at > now() - interval '30 days'`;
  return r?.n ?? 0;
}

async function leadOf(employeeId: string): Promise<string | null> {
  const [r] = await getServiceSql()<{ manager_employee_id: string | null }[]>`select manager_employee_id from employee where id = ${employeeId}`;
  return r?.manager_employee_id ?? null;
}

async function nameOf(employeeId: string): Promise<string> {
  const [r] = await getServiceSql()<{ display_name: string }[]>`select display_name from employee where id = ${employeeId}`;
  return r?.display_name ?? "someone";
}

/** Change the PIN: the person's own secret and current PIN prove it is them (a wrong one counts). Nobody else is signed out. */
export async function changePin(p: {
  deviceId: string;
  deviceSecret: string;
  employeeId: string;
  personSecret: string;
  pin: string;
  newPin: string;
  correlationId?: string;
}): Promise<{ changed: true }> {
  const bad = pinRefusal(p.newPin);
  if (bad) throw new DeviceAuthRefused(bad, 400, "weak_pin");
  const v = await verifyPersonPin(p);
  const newHash = await hashPin(p.newPin);
  await getServiceSql()`update app_credential set pin_hash = ${newHash}, pin_set_at = now() where id = ${v.credentialId} and revoked_at is null`;
  await audit("app.pin_changed", {
    actor: `employee:${v.employeeId}`,
    entity: "app_credential",
    entityId: v.credentialId,
    detail: { deviceId: v.device.id },
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  return { changed: true };
}

// ── Staying signed in ─────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  family_id: string;
  credential_id: string;
  device_id: string;
  employee_id: string;
  expires_at: Date;
  idle_until: Date;
  used_at: Date | null;
  replaced_by: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

const SIGN_IN_AGAIN = () => new DeviceAuthRefused("Please sign in again.", 401, "signed_out");
/** Why a pair is voided when the phone retries after a lost response — and how its later use is recognised. */
const LOST_RESPONSE = "replaced after a lost response";

export async function refreshSession(p: { deviceId: string; deviceSecret: string; refreshToken: string; correlationId?: string }): Promise<AppTokens> {
  const r = await getServiceSql().begin(async (tx) => {
    const d = await knownDevice(tx, p.deviceId, p.deviceSecret);
    // One refresh, sign-in or sign-out at a time per phone: a revoke never misses the pair a refresh is
    // still inserting (review #5).
    await lockPhone(tx, d.id);
    const [s] = await tx<SessionRow[]>`
      select id, family_id, credential_id, device_id, employee_id, expires_at, idle_until, used_at, replaced_by, revoked_at, revoke_reason
        from app_session where refresh_hash = ${sha256(p.refreshToken)} for update`;
    if (s && s.revoked_at && s.revoke_reason === LOST_RESPONSE) {
      // This pair was voided because its predecessor was presented again within the grace. A phone that
      // genuinely lost the response never received this pair — so whoever presents it holds a copy, and
      // two parties hold this family (RFC 9700 §4.14; review #4). End the family.
      await endFamily(tx, s.family_id, "voided refresh token presented");
      return { refused: SIGN_IN_AGAIN(), reuse: { familyId: s.family_id, sessionId: s.id, why: "voided_pair" } };
    }
    if (!s || s.revoked_at || s.expires_at <= new Date()) return { refused: SIGN_IN_AGAIN() };
    // A token from another phone is a copied token: end the family it came from.
    if (s.device_id !== d.id) {
      await endFamily(tx, s.family_id, "refresh token presented by another phone");
      return { refused: SIGN_IN_AGAIN(), reuse: { familyId: s.family_id, sessionId: s.id, why: "other_device" } };
    }
    if (s.replaced_by) {
      // Used before. Straight after a response that was probably lost — its successor never used — the
      // phone is only retrying: give it a new pair and void the one it never received. Otherwise two
      // parties hold this family's tokens and we cannot tell which is the phone: end the family.
      const [succ] = await tx<{ used_at: Date | null; revoked_at: Date | null }[]>`
        select used_at, revoked_at from app_session where id = ${s.replaced_by}`;
      const retry =
        s.used_at !== null && Date.now() - s.used_at.getTime() <= DEVICE_AUTH.refreshGraceSeconds * 1000 && succ !== undefined && !succ.used_at && !succ.revoked_at;
      if (!retry) {
        await endFamily(tx, s.family_id, "refresh token used twice");
        return { refused: SIGN_IN_AGAIN(), reuse: { familyId: s.family_id, sessionId: s.id, why: "reused" } };
      }
      await tx`update app_session set revoked_at = now(), revoke_reason = ${LOST_RESPONSE} where id = ${s.replaced_by}`;
    } else if (s.idle_until <= new Date()) {
      return { refused: SIGN_IN_AGAIN() };
    }
    // Live, and — on a shared phone — not someone who has since become CEO or Admin (review #6).
    const [live] = await tx<{ ok: boolean }[]>`
      select (c.revoked_at is null and c.disabled_at is null and e.status = 'active'
              and not (dv.kind = 'company' and (e.access_role in ('ceo', 'admin') or e.id = ${DEMO_CEO_ID}))) as ok
        from app_credential c join employee e on e.id = c.employee_id join device dv on dv.id = c.device_id
       where c.id = ${s.credential_id}`;
    if (!live?.ok) {
      await endFamily(tx, s.family_id, "credential or person no longer active");
      return { refused: SIGN_IN_AGAIN() };
    }
    const idleMs = d.kind === "company" ? companyIdleMinutes() * 60_000 : DEVICE_AUTH.personalIdleDays * 86_400_000;
    const tokens = await newPair(tx, {
      familyId: s.family_id,
      credentialId: s.credential_id,
      deviceId: d.id,
      employeeId: s.employee_id,
      expiresAt: s.expires_at,
      idleUntil: new Date(Math.min(s.expires_at.getTime(), Date.now() + idleMs)),
      ...(p.correlationId ? { correlationId: p.correlationId } : {}),
    });
    await tx`update app_session set used_at = coalesce(used_at, now()), replaced_by = ${tokens.sessionId} where id = ${s.id}`;
    return { tokens };
  });
  if ("reuse" in r && r.reuse) {
    await audit("app.refresh_reused", {
      actor: `device:${p.deviceId}`,
      entity: "app_session",
      entityId: r.reuse.sessionId,
      detail: { familyId: r.reuse.familyId, why: r.reuse.why, deviceId: p.deviceId },
      ...(p.correlationId ? { correlationId: p.correlationId } : {}),
    });
  }
  if ("refused" in r && r.refused) throw r.refused;
  return (r as { tokens: AppTokens }).tokens;
}

async function endFamily(tx: Tx, familyId: string, reason: string): Promise<number> {
  const r = await tx`update app_session set revoked_at = now(), revoke_reason = ${reason} where family_id = ${familyId} and revoked_at is null`;
  return r.count;
}

export async function signOut(p: { deviceId: string; deviceSecret: string; refreshToken: string; correlationId?: string }): Promise<{ signedOut: boolean }> {
  const r = await getServiceSql().begin(async (tx) => {
    const d = await knownDevice(tx, p.deviceId, p.deviceSecret);
    // After any refresh in flight on this phone, so its new pair ends too (review #5).
    await lockPhone(tx, d.id);
    const [s] = await tx<{ family_id: string; employee_id: string }[]>`
      select family_id, employee_id from app_session where refresh_hash = ${sha256(p.refreshToken)} and device_id = ${d.id}`;
    if (!s) return null;
    await endFamily(tx, s.family_id, "signed out");
    return s;
  });
  if (r) {
    await audit("app.signed_out", {
      actor: `employee:${r.employee_id}`,
      entity: "app_session",
      detail: { familyId: r.family_id, deviceId: p.deviceId },
      ...(p.correlationId ? { correlationId: p.correlationId } : {}),
    });
  }
  return { signedOut: Boolean(r) };
}

/** True for a string shaped like one of our access tokens — the API's hook uses it to pick the path. */
export function isAppAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_PREFIX) && /^fna_[A-Za-z0-9_-]{43}$/.test(token);
}

/**
 * Whose access token is this? A POSITIVE check on every request: the session row exists, its access
 * token is unexpired, the family not ended, the phone not switched off, the credential neither revoked
 * nor disabled, the person active. An unknown token is nobody's. There is no signing key that could
 * mint a token this does not know.
 */
export async function appSessionFor(accessToken: string): Promise<{ employeeId: string; deviceId: string; sessionId: string } | null> {
  if (!isAppAccessToken(accessToken)) return null;
  const [r] = await getServiceSql()<{ id: string; employee_id: string; device_id: string }[]>`
    select s.id, s.employee_id, s.device_id
      from app_session s
      join device d on d.id = s.device_id
      join app_credential c on c.id = s.credential_id
      join employee e on e.id = s.employee_id
     where s.access_hash = ${sha256(accessToken)} and s.access_expires_at > now() and s.expires_at > now()
       and s.revoked_at is null and d.revoked_at is null and c.revoked_at is null and c.disabled_at is null
       and c.employee_id = s.employee_id and c.device_id = s.device_id and e.status = 'active'
       -- Never the CEO or an Admin on a shared phone, whatever their role was at set-up (review #6).
       and not (d.kind = 'company' and (e.access_role in ('ceo', 'admin') or e.id = ${DEMO_CEO_ID}))`;
  return r ? { employeeId: r.employee_id, deviceId: r.device_id, sessionId: r.id } : null;
}

// ── For the CEO and Admins ────────────────────────────────────────────────────

export async function revokeDevice(p: { actor: ViewerOrg; deviceId: string; reason?: string; correlationId?: string }): Promise<{ revoked: boolean }> {
  if (!can(p.actor, "people.manage")) throw new DeviceAuthRefused("Only the CEO or an Admin switches phones off.", 403, "forbidden");
  // A personal phone of the CEO or an Admin is theirs to switch off, or the CEO's — as with setting it up.
  const [owner] = await getServiceSql()<{ id: string; access_role: string }[]>`
    select e.id, e.access_role from device d join employee e on e.id = d.bound_employee_id where d.id = ${p.deviceId}`;
  if (owner && guardedTarget(owner) && owner.id !== p.actor.employeeId && !p.actor.isCeo) {
    throw new DeviceAuthRefused("The CEO's and Admins' own phones are switched off by the CEO or by themselves.", 403, "forbidden");
  }
  const reason = (p.reason ?? "switched off").slice(0, 200);
  const done = await getServiceSql().begin(async (tx) => {
    const [d] = await tx<{ id: string }[]>`
      update device set revoked_at = now(), revoked_by = ${p.actor.employeeId}, revoke_reason = ${reason}
       where id = ${p.deviceId} and revoked_at is null returning id`;
    if (!d) return false;
    await tx`update app_credential set revoked_at = now(), revoked_by = ${p.actor.employeeId} where device_id = ${d.id} and revoked_at is null`;
    await tx`update app_session set revoked_at = now(), revoke_reason = 'phone switched off' where device_id = ${d.id} and revoked_at is null`;
    return true;
  });
  if (done) {
    await audit("device.revoked", {
      actor: `employee:${p.actor.employeeId}`,
      entity: "device",
      entityId: p.deviceId,
      detail: { reason },
      ...(p.correlationId ? { correlationId: p.correlationId } : {}),
    });
  }
  return { revoked: done };
}

/** A person's own credential, or one of someone they lead, or anyone's for the CEO and Admins. */
export async function revokeCredential(p: { actor: ViewerOrg; credentialId: string; correlationId?: string }): Promise<{ revoked: boolean }> {
  const sql = getServiceSql();
  const [c] = await sql<{ id: string; employee_id: string; manager_employee_id: string | null; access_role: string }[]>`
    select c.id, c.employee_id, e.manager_employee_id, e.access_role
      from app_credential c join employee e on e.id = c.employee_id where c.id = ${p.credentialId} and c.revoked_at is null`;
  if (!c) return { revoked: false };
  const self = c.employee_id === p.actor.employeeId;
  const leads = can(p.actor, "people.view_reports") && c.manager_employee_id === p.actor.employeeId;
  if (!self && !leads && !can(p.actor, "people.manage")) throw new DeviceAuthRefused("That sign-in is not yours to end.", 403, "forbidden");
  if (!self && !p.actor.isCeo && guardedTarget({ id: c.employee_id, access_role: c.access_role })) {
    throw new DeviceAuthRefused("The CEO's and Admins' phone sign-in is ended by the CEO or by themselves.", 403, "forbidden");
  }
  await sql.begin(async (tx) => {
    await tx`update app_credential set revoked_at = now(), revoked_by = ${p.actor.employeeId} where id = ${c.id} and revoked_at is null`;
    await tx`update app_session set revoked_at = now(), revoke_reason = 'sign-in removed' where credential_id = ${c.id} and revoked_at is null`;
  });
  await audit("app.credential_revoked", {
    actor: `employee:${p.actor.employeeId}`,
    entity: "app_credential",
    entityId: c.id,
    detail: { employeeId: c.employee_id },
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  return { revoked: true };
}

export interface DeviceSummary {
  id: string;
  kind: "company" | "personal";
  label: string;
  boundEmployeeId: string | null;
  enrolledAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Security state per person — deliberately no sign-in times: this is not an attendance record (D210). */
  people: { credentialId: string; employeeId: string; displayName: string; failedCount: number; disabled: boolean }[];
}

/** Every phone and who is set up on it — for the CEO and Admins. */
export async function listDevices(p: { actor: ViewerOrg }): Promise<DeviceSummary[]> {
  if (!can(p.actor, "people.manage")) throw new DeviceAuthRefused("Only the CEO or an Admin sees every phone.", 403, "forbidden");
  const sql = getServiceSql();
  const devices = await sql<{ id: string; kind: "company" | "personal"; label: string; bound_employee_id: string | null; enrolled_at: Date; last_seen_at: Date | null; revoked_at: Date | null }[]>`
    select id, kind, label, bound_employee_id, enrolled_at, last_seen_at, revoked_at from device order by revoked_at nulls first, label`;
  const creds = await sql<{ id: string; device_id: string; employee_id: string; display_name: string; failed_count: number; disabled_at: Date | null }[]>`
    select c.id, c.device_id, c.employee_id, e.display_name, c.failed_count, c.disabled_at
      from app_credential c join employee e on e.id = c.employee_id where c.revoked_at is null order by e.display_name`;
  return devices.map((d) => ({
    id: d.id,
    kind: d.kind,
    label: d.label,
    boundEmployeeId: d.bound_employee_id,
    enrolledAt: d.enrolled_at.toISOString(),
    // Where a shared phone was last used helps find it; a personal phone's is one person's activity,
    // minute by minute — not shown (review #8, D216).
    lastSeenAt: d.kind === "company" ? (d.last_seen_at?.toISOString() ?? null) : null,
    revokedAt: d.revoked_at?.toISOString() ?? null,
    people: creds
      .filter((c) => c.device_id === d.id)
      .map((c) => ({ credentialId: c.id, employeeId: c.employee_id, displayName: c.display_name, failedCount: c.failed_count, disabled: c.disabled_at !== null })),
  }));
}

/**
 * Housekeeping, hourly from the worker: sessions ended or expired more than 30 days ago, and codes past
 * their time, are deleted. A sign-in record is kept for security, not as a record of who worked when.
 */
export async function pruneAppAuth(p: { correlationId?: string } = {}): Promise<{ sessions: number; codes: number; enrolments: number }> {
  const sql = getServiceSql();
  const days = DEVICE_AUTH.pruneAfterDays;
  // A pair is named by the one before it (replaced_by); a row whose predecessor stays is kept with it.
  const sessions = await sql`
    with gone as (
      select id from app_session
       where coalesce(revoked_at, expires_at) < now() - make_interval(days => ${days})
    )
    delete from app_session where id in (select id from gone)
       and not exists (select 1 from app_session pred where pred.replaced_by = app_session.id and pred.id not in (select id from gone))`;
  // A used code stays while a credential points at it (app_credential.setup_code_id has no ON DELETE):
  // deleting it failed every hour from the 31st day on, and stopped the rest of the housekeeping (review #3).
  const codes = await sql`
    delete from app_setup_code s where s.expires_at < now() - make_interval(days => ${days})
       and not exists (select 1 from app_credential c where c.setup_code_id = s.id)`;
  const enrolments = await sql`delete from device_enrolment where expires_at < now() - make_interval(days => ${days}) and device_id is null`;
  if (sessions.count + codes.count + enrolments.count > 0) {
    await audit("app.pruned", {
      actor: "system",
      entity: "app_session",
      detail: { sessions: sessions.count, codes: codes.count, enrolments: enrolments.count },
      ...(p.correlationId ? { correlationId: p.correlationId } : {}),
    });
  }
  return { sessions: sessions.count, codes: codes.count, enrolments: enrolments.count };
}
