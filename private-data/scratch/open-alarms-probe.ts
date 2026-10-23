/**
 * Read-only probe (review finding command-centre#1): does Televend's events list filter to the alarms
 * still open (resolved=false) without a time window? Prints counts and ids only — no names.
 * GET requests through the allow-listed client; nothing is written anywhere.
 */
import "dotenv/config";
import postgres from "postgres";
import { PasswordSession, TelevendClient, dubaiIso, readTelevendConfig } from "../../packages/televend/src/index.js";
import { eventsPage } from "../../packages/televend/src/schemas.js";

const config = readTelevendConfig();
if (!config || !config.username || !config.password) throw new Error("no Televend config");
const session = new PasswordSession({ username: config.username, password: config.password }, { fetch: globalThis.fetch as never, now: Date.now });
const client = new TelevendClient(session, { tenantId: config.tenantId, companyId: config.companyId, minIntervalMs: Math.max(config.minIntervalMs, 1_000) });
const T = `tenants/${config.tenantId}/companies/${config.companyId}`;

const open = new Map<number, { start: string; resolved: string | null; level: unknown }>();
let pages = 0;
for (let page = 1; page <= 10; page++) {
  const r = await client.get(TelevendClient.url("api-cloud.televendcloud.com", `/machinist/api/v1/${T}/events`, { page, page_size: 100, resolved: "false", from_timestamp: dubaiIso(new Date(Date.now() - 14 * 86_400_000)), to_timestamp: dubaiIso(new Date()) }), eventsPage);
  pages++;
  for (const e of r.content) open.set(e.id, { start: e.start_time, resolved: e.resolved_time ?? null, level: (e as Record<string, unknown>).level });
  if (!r.meta.has_next_page) break;
}
const withResolved = [...open.values()].filter((e) => e.resolved !== null).length;
const starts = [...open.values()].map((e) => Date.parse(e.start)).sort((a, b) => a - b);
console.log(JSON.stringify({ pages, openInTelevend: open.size, ofThemWithResolvedTime: withResolved, oldestStart: starts[0] ? new Date(starts[0]).toISOString() : null }));

const sql = postgres(process.env.DATABASE_URL_SERVICE!, { max: 1 });
await sql`set default_transaction_read_only = on`;
const mirror = await sql<{ external_id: string; started_at: Date }[]>`
  select external_id, started_at from tv_event
   where kind in ('alarm', 'warning') and resolved_at is null and started_at > now() - interval '14 days'`;
const mirrorIds = mirror.map((m) => Number(m.external_id));
const stillOpen = mirrorIds.filter((id) => open.has(id)).length;
console.log(JSON.stringify({ openInMirror: mirror.length, alsoOpenInTelevend: stillOpen, resolvedInTelevendButOpenHere: mirror.length - stillOpen }));
await sql.end();
