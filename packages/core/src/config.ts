import { z } from "zod";

// Telegram user ids exceed 32-bit range — always carry them as bigint.
// (knowledge-base G2: using int silently corrupts identity mapping.)
const telegramUserId = z.coerce.bigint();
/** `NAME=` in .env means "not set", not zero — so a blank line cannot break every loadConfig(). */
const blankIsDefault = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

export const configSchema = z.object({
  /**
   * Optional shared secret for the dashboard and its API.
   *
   * The dashboard binds to 0.0.0.0 so a phone on the same wifi can reach it, and unless
   * SUPABASE_URL is set it has NO login — which means anyone on that network can read every employee's data and use
   * the natural-language query box. That is an accepted demo trade-off on a private
   * network, and it must not be pretended away.
   *
   * Set this and every `/dashboard/*` request must carry it (`?k=` or `X-Dashboard-Key`).
   * Left unset, the dashboard stays open — the demo behaviour, stated rather than hidden.
   */
  DASHBOARD_TOKEN: z.string().min(8).optional(),

  /**
   * Supabase project for dashboard sign-in. When set, every `/dashboard/*` request must
   * carry a Supabase Auth JWT, and the viewer is the employee linked to that account —
   * `?viewer=` is ignored. When unset, the dashboard runs in demo mode as before.
   */
  SUPABASE_URL: z.string().url().optional(),
  /** Public anon key, handed to the React app so it can call Supabase Auth. Not a secret. */
  SUPABASE_ANON_KEY: z.string().min(20).optional(),
  /** Only for projects still on the legacy shared HS256 secret; asymmetric keys need none. */
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),

  // ── Database & queue ────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres connection string"),
  // Service-role (BYPASSRLS) connection — worker/outbox/migrations only.
  DATABASE_URL_SERVICE: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres connection string")
    .optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // ── LLM providers (at least one key needed before Task 004 runs) ─────
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  // OpenRouter: an INDEPENDENT provider, so a Groq outage does not take the fallback
  // with it (a second Groq model would). Measured 2026-09-07: gpt-4o-mini 6/6 correct
  // on the multilingual extraction set at ~1.6 s.
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL: z.string().default("openai/gpt-4o-mini"),
  NVIDIA_API_KEY: z.string().optional(),
  NVIDIA_BASE_URL: z
    .string()
    .url()
    .default("https://integrate.api.nvidia.com/v1"),
  NVIDIA_MODEL: z
    .string()
    .default("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
  LLM_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(2),

  // ── Telegram ─────────────────────────────────────────────────────────
  BOT_TOKEN: z.string().optional(),
  CEO_TELEGRAM_USER_ID: telegramUserId.optional(),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  // Webhook mode. All three are REQUIRED when TELEGRAM_MODE=webhook; the bot refuses to
  // start without them rather than listening unverified (fail closed). The length rule is
  // enforced THERE, not here: `loadConfig()` runs on every model call, and a `.min(16)` in
  // this schema turned an empty `TELEGRAM_WEBHOOK_SECRET=` in .env — harmless in polling
  // mode — into a thrown error inside every LLM call. Found by the answer tests, 2026-09-18.
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  /** The public HTTPS origin Caddy serves, e.g. https://ops.example.ae — Telegram calls it. */
  PUBLIC_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_PATH: z.string().regex(/^\/[\w\-\/]+$/).default("/telegram/webhook"),
  TELEGRAM_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(3002),

  // ── Phone sign-in (TASK-058, D210) ───────────────────────────────────
  // The pepper: keys the PIN hashes and the hashes of typed codes, kept outside the database so a copy
  // of it cannot be used to guess either. At least 32 random characters. Unset: phone sign-in answers
  // "not set up" (503). Changing it later means everyone sets their PIN again.
  APP_PIN_PEPPER: z.string().optional(),
  /** Shift handovers, Asia/Dubai, "HH:MM,HH:MM": a company phone's sign-in ends at the next one (+30 min). */
  APP_SHIFT_HANDOVERS: z.string().optional(),
  /** A company phone silent this long needs the PIN again. */
  APP_COMPANY_IDLE_MINUTES: blankIsDefault(z.coerce.number().int().min(5).max(24 * 60).optional()),

  // ── Live updates (TASK-058) ──────────────────────────────────────────
  // Sized by `pnpm live:load` (measured, not guessed). Past either limit a board is told to keep
  // polling (D93) — nothing is lost, it is only slower. A blank value means the default.
  /** Live streams one API process serves at once. */
  LIVE_MAX_STREAMS: blankIsDefault(z.coerce.number().int().min(1).max(10_000).default(500)),
  /** Per person — their tabs and phones — so one leaking browser cannot take every slot. */
  LIVE_MAX_STREAMS_PER_PERSON: blankIsDefault(z.coerce.number().int().min(1).max(100).default(8)),

  // ── Operations (TASK-059) ────────────────────────────────────────────
  /**
   * "on": a Televend alarm still open after its on-delay becomes a problem (blocker) — routed, timed,
   * escalated, and paged like any other. Off by default: until routing rules point machine alarms at
   * the people who run the machines, every one of ~30 a day would page the CEO. The Operations
   * portal lists the alarms that need action either way.
   */
  OPS_ALARM_PROBLEMS: blankIsDefault(z.enum(["on", "off"]).default("off")),
  /** A cash vend's price when the machine has none set (fils). A-T62.1: AED 10. */
  OPS_DEFAULT_CASH_PRICE_FILS: blankIsDefault(z.coerce.number().int().min(100).max(100_000).default(1000)),

  // ── Stock (TASK-060) ─────────────────────────────────────────────────
  /**
   * Minutes a handover may wait for the other side before they are reminded, once. 0 = never.
   * A-T60.3: 30 — a team is usually still at the warehouse then.
   */
  INVENTORY_HANDOVER_REMIND_MINUTES: blankIsDefault(z.coerce.number().int().min(0).max(1440).default(30)),
  /**
   * Minutes after stock was given out before the warehouse is asked to count what is left, once per
   * hand-out round — the CEO asks for "the stock after the first team" every morning (VF74). 0 = never.
   * A-T60.3: 30.
   */
  INVENTORY_COUNT_REMIND_MINUTES: blankIsDefault(z.coerce.number().int().min(0).max(1440).default(30)),

  // ── Misc ─────────────────────────────────────────────────────────────
  // Store UTC in the DB, render Asia/Dubai. UAE working week is Mon–Fri.
  TZ: z.string().default("Asia/Dubai"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parse and validate the process environment into a typed Config.
 * Throws with a readable message listing every invalid/missing field.
 * Boundary validation per the "unknown + Zod parse at boundaries" rule.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
