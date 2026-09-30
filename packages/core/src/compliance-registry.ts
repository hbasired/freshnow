import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * The compliance registry (compliance/processors.json): reading and validating it, and the
 * per-call settings it drives. Kept apart from compliance.ts so the model client can read it
 * without importing the consent notice and everything behind it.
 */

const Dpa = z.object({
  status: z.enum(["accepted", "not_filed", "not_available"]),
  accepted_on: z.string().nullable(),
  note: z.string().optional(),
});

const Service = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(["processor", "independent", "relay", "internal", "demo_only"]),
  country: z.string().min(1),
  personal_data: z.array(z.string()),
  ground: z.array(z.enum(["consent", "contract", "not_personal_data_transfer", "not_for_real_data"])),
  dpa: Dpa,
  controls: z
    .object({
      zero_data_retention: z.boolean().optional(),
      data_collection: z.enum(["allow", "deny"]).optional(),
      confirmed_on: z.string().nullable().optional(),
    })
    .default({}),
  how_to_confirm: z.string(),
  sources: z.array(z.string()),
});

export const RegistrySchema = z.object({
  version: z.literal(1),
  reviewed_on: z.string(),
  hosting: z.object({ provider: z.string().min(1), name: z.string().min(1), country: z.string().length(2), note: z.string().optional() }),
  hosting_countries_allowed: z.array(z.string().length(2)).min(1),
  retention_days: z.number().int().positive().nullable(),
  services: z.array(Service),
});

export type Registry = z.infer<typeof RegistrySchema>;
export type RegistryService = z.infer<typeof Service>;

export type RuleId = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export interface Finding {
  rule: RuleId;
  /** "block": production refuses to start. "warn": wrong or incomplete, but not fatal. */
  level: "block" | "warn";
  service?: string;
  message: string;
  fix: string;
}

export interface PolicyReport {
  /** IS_DEMO=false. Only then does a "block" stop anything. */
  production: boolean;
  findings: Finding[];
  /** Production AND at least one blocking finding: the process must not start. */
  refuse: boolean;
  /** The services the configuration can reach right now, by registry id. */
  reachable: string[];
}

type Env = NodeJS.ProcessEnv;

export function isProduction(env: Env = process.env): boolean {
  return (env.IS_DEMO ?? "true").toLowerCase() === "false";
}

export function registryPath(env: Env = process.env): string {
  return env.COMPLIANCE_REGISTRY ?? join(process.cwd(), "compliance", "processors.json");
}

/** Read and validate the registry. Never throws: a broken registry is finding R0, not a crash. */
export function readRegistry(path: string = registryPath()): { registry: Registry } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { error: `No registry at ${path}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { error: `The registry is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = RegistrySchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: `The registry does not match its schema: ${first ? `${first.path.join(".")} — ${first.message}` : "invalid"}` };
  }
  return { registry: parsed.data };
}

let cached: { path: string; result: ReturnType<typeof readRegistry> } | null = null;

/** The registry, read once per process — the process is restarted whenever it changes. */
export function registry(env: Env = process.env): ReturnType<typeof readRegistry> {
  const path = registryPath(env);
  if (!cached || cached.path !== path) cached = { path, result: readRegistry(path) };
  return cached.result;
}

/**
 * The OpenRouter routing fields the registry asks for (rule R4, per call). Only what the
 * registry has confirmed is sent, so a demo with the defaults sends exactly what it did before.
 * UNVERIFIED against a live OpenRouter call from this environment: the field names are from
 * OpenRouter's provider-routing documentation, read through search on 2026-09-30.
 */
export function openRouterDataPolicy(env: Env = process.env): { zdr?: true; data_collection?: "deny" } | null {
  const r = registry(env);
  if ("error" in r) return null;
  const c = r.registry.services.find((s) => s.id === "openrouter")?.controls;
  const out: { zdr?: true; data_collection?: "deny" } = {};
  if (c?.zero_data_retention === true) out.zdr = true;
  if (c?.data_collection === "deny") out.data_collection = "deny";
  return Object.keys(out).length ? out : null;
}
