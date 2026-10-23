import { z } from "zod";

/**
 * Televend settings, read from the environment at the boundary.
 *
 * Like email (G97), Televend is optional: when nothing is configured the rest of the system
 * runs exactly as before, so this returns `null` instead of throwing. It throws only when the
 * settings are present but contradictory — a half-configured connector should fail loudly at
 * start-up, not at 3 a.m. inside a sync job.
 *
 * Secrets (password, client secret) live only in this object and in the auth module. They are
 * never logged, never put in an error message and never sent anywhere except Televend's own
 * token endpoint (asserted by tests).
 */

export const TELEVEND_MODES = ["bridge", "official", "files"] as const;
export type TelevendMode = (typeof TELEVEND_MODES)[number];

const schema = z
  .object({
    TELEVEND_MODE: z.enum(TELEVEND_MODES).default("bridge"),
    TELEVEND_USERNAME: z.string().trim().min(3).optional(),
    TELEVEND_PASSWORD: z.string().min(1).optional(),
    TELEVEND_COMPANY_ID: z.coerce.number().int().positive().default(3334),
    /** The web app fills `{tenant_id}` with this ("scope" in its environment file; 5 on 2026-10-15). */
    TELEVEND_TENANT_ID: z.coerce.number().int().positive().default(5),
    TELEVEND_CLIENT_ID: z.string().trim().min(1).optional(),
    TELEVEND_CLIENT_SECRET: z.string().min(1).optional(),
    /** Official API gateway incl. base path. Default = the documented UAT gateway. */
    TELEVEND_OFFICIAL_BASE_URL: z.string().url().default("https://uat-api.televendcloud.com/televend-api"),
    /** Official API token endpoint. Default = the documented UAT Keycloak realm. */
    TELEVEND_OFFICIAL_TOKEN_URL: z
      .string()
      .url()
      .default("https://uat-auth.televendcloud.com/auth/realms/gravitee3/protocol/openid-connect/token"),
    /** Committing stream offsets is the one write the official API needs; off until asked for. */
    TELEVEND_COMMIT_OFFSETS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** Minimum gap between two requests. The developer portal asks for ≤ 1 request/second. */
    TELEVEND_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),
    /** Folder the file-import transport reads exports from. */
    TELEVEND_IMPORT_DIR: z.string().default("private-data/televend-imports"),
  })
  .superRefine((v, ctx) => {
    if (v.TELEVEND_MODE === "bridge" && (!v.TELEVEND_USERNAME || !v.TELEVEND_PASSWORD)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "bridge mode needs TELEVEND_USERNAME and TELEVEND_PASSWORD" });
    }
    if (v.TELEVEND_MODE === "official" && (!v.TELEVEND_CLIENT_ID || !v.TELEVEND_CLIENT_SECRET)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "official mode needs TELEVEND_CLIENT_ID and TELEVEND_CLIENT_SECRET" });
    }
  });

export interface TelevendConfig {
  readonly mode: TelevendMode;
  readonly companyId: number;
  readonly tenantId: number;
  readonly username?: string;
  readonly password?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly officialBaseUrl: string;
  readonly officialTokenUrl: string;
  readonly commitOffsets: boolean;
  readonly minIntervalMs: number;
  readonly importDir: string;
}

/** True when any Televend setting is present — i.e. the operator meant to turn it on. */
export function televendConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.keys(env).some((k) => k.startsWith("TELEVEND_") && (env[k] ?? "") !== "");
}

/**
 * The settings, or `null` when Televend is not configured at all. Throws (without echoing any
 * value) when settings are present but incomplete.
 */
export function readTelevendConfig(env: NodeJS.ProcessEnv = process.env): TelevendConfig | null {
  if (!televendConfigured(env)) return null;
  const picked = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => k.startsWith("TELEVEND_") && v !== undefined && v !== ""),
  );
  const parsed = schema.safeParse(picked);
  if (!parsed.success) {
    // Issue paths and messages only — never the received values (one of them is a password).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(settings)"}: ${i.message}`).join("; ");
    throw new Error(`Televend settings are incomplete: ${issues}`);
  }
  const v = parsed.data;
  return {
    mode: v.TELEVEND_MODE,
    companyId: v.TELEVEND_COMPANY_ID,
    tenantId: v.TELEVEND_TENANT_ID,
    ...(v.TELEVEND_USERNAME !== undefined && { username: v.TELEVEND_USERNAME }),
    ...(v.TELEVEND_PASSWORD !== undefined && { password: v.TELEVEND_PASSWORD }),
    ...(v.TELEVEND_CLIENT_ID !== undefined && { clientId: v.TELEVEND_CLIENT_ID }),
    ...(v.TELEVEND_CLIENT_SECRET !== undefined && { clientSecret: v.TELEVEND_CLIENT_SECRET }),
    officialBaseUrl: v.TELEVEND_OFFICIAL_BASE_URL.replace(/\/+$/, ""),
    officialTokenUrl: v.TELEVEND_OFFICIAL_TOKEN_URL,
    commitOffsets: v.TELEVEND_COMMIT_OFFSETS,
    minIntervalMs: v.TELEVEND_MIN_INTERVAL_MS,
    importDir: v.TELEVEND_IMPORT_DIR,
  };
}
