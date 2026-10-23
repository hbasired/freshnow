/**
 * FreshNow ↔ Televend MCP server (TASK-055) — read-only, stdio.
 *
 * Lets Claude Code (or any MCP client) ask "what happened on 12 Oct?" against Televend without
 * anyone being able to change anything there: every tool goes through @freshnow/televend, whose
 * client refuses any request not on its allow-list before it leaves the process. There is no
 * write tool, and none can be added without changing the allow-list and its tests.
 *
 * Answers are computed in code (tools.ts) and bounded to 50 rows; names default to initials.
 *
 * stdio rule: NOTHING may be written to stdout except the protocol. Logs go to stderr; dotenv
 * runs with `quiet: true` (dotenv 17 otherwise prints a line to stdout).
 *
 * Registered for Claude Code in the project's .mcp.json.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  BridgeSource,
  FileSource,
  PasswordSession,
  TelevendClient,
  readTelevendConfig,
  type TelevendSource,
} from "@freshnow/televend";
import { cashCollectionsDay, eventsDay, machinesSummary, recordsForAsset, refillsDay, salesDay } from "./tools.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: resolve(repoRoot, ".env"), quiet: true });

const log = (msg: string): void => {
  process.stderr.write(`[mcp-televend] ${msg}\n`);
};

interface Connection {
  source: TelevendSource;
  client: TelevendClient | null;
  session: PasswordSession | null;
}
let connection: Connection | null = null;

/** Connect lazily, so the server starts (and lists its tools) even before credentials exist. */
function connect(): Connection {
  if (connection) return connection;
  const config = readTelevendConfig();
  if (!config) throw new Error("Televend is not configured: set TELEVEND_MODE and its settings in .env");
  if (config.mode === "files") {
    connection = { source: new FileSource(resolve(repoRoot, config.importDir)), client: null, session: null };
  } else if (config.mode === "bridge" && config.username && config.password) {
    const session = new PasswordSession({ username: config.username, password: config.password }, { fetch: globalThis.fetch as never, now: Date.now });
    const client = new TelevendClient(session, {
      tenantId: config.tenantId,
      companyId: config.companyId,
      minIntervalMs: Math.max(1_000, config.minIntervalMs),
    });
    connection = { source: new BridgeSource(client, { tenantId: config.tenantId, companyId: config.companyId }), client, session };
  } else {
    // The official API is a stream consumer, not a query service — it feeds the sync job
    // (TASK-056), not interactive questions.
    throw new Error(`TELEVEND_MODE=${config.mode} is not served by this MCP server; use bridge or files`);
  }
  log(`connected (${config.mode})`);
  return connection;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a business day as YYYY-MM-DD (Asia/Dubai)");
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true, destructiveHint: false } as const;

async function answer(work: () => Promise<unknown>) {
  try {
    const result = await work();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Connector errors never contain credentials or tokens (tested in @freshnow/televend).
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log(`tool failed: ${message}`);
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "freshnow-televend", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.registerTool(
    "televend_status",
    {
      title: "Televend connection status",
      description:
        "How the connector is reading Televend (bridge / files), whether sign-in is healthy, how many requests were sent, and whether calls are paused after errors. Read-only.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      answer(async () => {
        const c = connect();
        return {
          transport: c.source.transport,
          requestsSent: c.client?.sent ?? 0,
          passwordSignIns: c.session?.passwordSignIns ?? 0,
          signInStopped: c.session?.latched ?? false,
          circuit: c.client?.circuit ?? null,
          readOnly: "every request is checked against an allow-list of GET endpoints before it is sent",
        };
      }),
  );

  server.registerTool(
    "televend_machines",
    {
      title: "Machines",
      description:
        "Televend's vending machines with region, type, last vend, last refill and stock %. Filter by part of the name or by the asset number (e.g. 791). At most 50 rows; totals are counted over all machines.",
      inputSchema: z.object({
        enabledOnly: z.boolean().default(true).describe("only machines enabled in Televend (87 on 2026-10-15)"),
        search: z.string().max(60).optional().describe("part of the machine name, or its asset number"),
        limit: z.number().int().min(1).max(50).default(50),
      }),
      annotations: READ_ONLY,
    },
    async ({ enabledOnly, search, limit }) =>
      answer(async () => machinesSummary(await connect().source.machines(), { enabledOnly, search, limit })),
  );

  server.registerTool(
    "televend_sales_day",
    {
      title: "Sales on a day",
      description:
        "Cups sold on one business day (Asia/Dubai), by payment type (Cash, Cashless, Cashless 3, Token, Wallet), top machines, and Televend's own count as a cross-check. Revenue only if the Televend account may see it.",
      inputSchema: z.object({ day }),
      annotations: READ_ONLY,
    },
    async ({ day: d }) => answer(async () => salesDay(connect().source, d)),
  );

  server.registerTool(
    "televend_events_day",
    {
      title: "Alarms and events on a day",
      description:
        "Machine alarms (default), warnings or info events on one business day: counts by level, top reasons, unresolved count, and up to 50 rows with how long each stayed open. Optionally one machine by asset number.",
      inputSchema: z.object({
        day,
        level: z.enum(["alarm", "warning", "info", "all"]).default("alarm"),
        asset: z.number().int().optional().describe("machine asset number, e.g. 791"),
        limit: z.number().int().min(1).max(50).default(50),
      }),
      annotations: READ_ONLY,
    },
    async ({ day: d, level, asset, limit }) => answer(async () => eventsDay(connect().source, d, { level, asset, limit })),
  );

  server.registerTool(
    "televend_refills_day",
    {
      title: "Refills on a day",
      description:
        "Machine refills (cups added, corrections) on one business day, with who filled (initials unless names='full'), cups per person, and up to 50 rows. Televend's refill log is per machine record: a whole day asks every record, disabled ones too (a machine that moved keeps its old record's log), and takes about 4 minutes (one request per record, 1 per second); pass an asset number to ask about one machine (all its records, a few seconds).",
      inputSchema: z.object({
        day,
        asset: z.number().int().optional(),
        names: z.enum(["initials", "full"]).default("initials"),
        limit: z.number().int().min(1).max(50).default(50),
      }),
      annotations: READ_ONLY,
    },
    async ({ day: d, asset, names, limit }) =>
      answer(async () => {
        const c = connect();
        // One machine → its Televend records first (enabled or not), so only their logs are read.
        if (asset === undefined) return refillsDay(c.source, d, { names, limit });
        const records = recordsForAsset(await c.source.machines(), asset);
        // "0 refills" for a number no record carries would read as "not refilled".
        if (records.length === 0) return { day: d, available: false, reason: `no Televend machine record has asset number ${asset}` };
        return refillsDay(c.source, d, { asset, names, limit, machineIds: records.map((r) => r.televendId), records });
      }),
  );

  server.registerTool(
    "televend_cash_collections_day",
    {
      title: "Cash collections on a day",
      description:
        "When each machine's cash was collected on one business day, from Televend's machine events ('Cash has been collected from the machine.'). Amounts are not included: they need Televend's cash-centre permission.",
      inputSchema: z.object({ day }),
      annotations: READ_ONLY,
    },
    async ({ day: d }) => answer(async () => cashCollectionsDay(connect().source, d)),
  );

  return server;
}

serveStdio(() => buildServer());
log("ready (stdio)");
