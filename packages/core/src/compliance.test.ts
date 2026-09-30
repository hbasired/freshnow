import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkPolicyAtStartup, evaluatePolicy, openRouterDataPolicy, readRegistry, registryPath, type Registry } from "./compliance.js";

/**
 * Policy as code: each rule from the CEO deck (slide 11) tested from its wording — what must be
 * refused, and what must pass. The shipped registry is checked too: it has to parse, and in the
 * demo it has to report without ever stopping anything.
 */

const base = (): Registry => ({
  version: 1,
  reviewed_on: "2026-09-30",
  hosting: { provider: "dubai-vps", name: "A Dubai VPS", country: "AE" },
  hosting_countries_allowed: ["AE", "LT", "DE", "FR"],
  retention_days: 365,
  services: [
    {
      id: "telegram", name: "Telegram", role: "independent", country: "outside the UAE", personal_data: ["messages"],
      ground: ["consent"], dpa: { status: "not_available", accepted_on: null }, controls: {}, how_to_confirm: "-", sources: [],
    },
    {
      id: "groq", name: "Groq, Inc.", role: "processor", country: "US", personal_data: ["update text"],
      ground: ["consent", "contract"], dpa: { status: "accepted", accepted_on: "2026-10-01" },
      controls: { zero_data_retention: true, confirmed_on: "2026-10-01" }, how_to_confirm: "switch ZDR on", sources: [],
    },
  ],
});

/** A production configuration that satisfies every rule. */
const goodEnv = (): NodeJS.ProcessEnv => ({
  IS_DEMO: "false", BOT_TOKEN: "1:x", GROQ_API_KEY: "g", RETENTION_DAYS: "365", SUPABASE_URL: "https://auth.example.ae",
});

const rules = (reg: Registry | { error: string }, env: NodeJS.ProcessEnv, extra: { requestHost?: string; viaCloudflare?: boolean } = {}) =>
  evaluatePolicy({ registry: "error" in reg ? reg : { registry: reg }, env, ...extra });

describe("the shipped registry", () => {
  it("parses, and in the demo reports without refusing", () => {
    const r = readRegistry(join(process.cwd(), "compliance", "processors.json"));
    expect("registry" in r).toBe(true);
    const report = evaluatePolicy({ registry: r, env: { BOT_TOKEN: "1:x", GROQ_API_KEY: "g", OPENROUTER_API_KEY: "o" } });
    expect(report.production).toBe(false);
    expect(report.refuse).toBe(false);
    // …but it is honest about what production would need.
    expect(report.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["R2", "R3", "R4", "R6"]));
  });
});

describe("rules", () => {
  it("a fully compliant production configuration passes", () => {
    const report = rules(base(), goodEnv());
    expect(report.findings).toEqual([]);
    expect(report.refuse).toBe(false);
    expect(report.reachable).toEqual(["telegram", "groq"]);
  });

  it("R0 — no registry: production refuses, the demo does not", () => {
    expect(rules({ error: "No registry" }, goodEnv()).refuse).toBe(true);
    expect(rules({ error: "No registry" }, { ...goodEnv(), IS_DEMO: "true" }).refuse).toBe(false);
  });

  it("R1 — a configured service nobody registered", () => {
    const report = rules(base(), { ...goodEnv(), NVIDIA_API_KEY: "n" });
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "R1", level: "block", service: "nvidia" }));
    expect(report.refuse).toBe(true);
  });

  it("R2 — a contract ground needs a filed DPA; a processor with none on offer is refused", () => {
    const noDpa = base();
    noDpa.services[1]!.dpa = { status: "not_filed", accepted_on: null };
    expect(rules(noDpa, goodEnv()).findings).toContainEqual(expect.objectContaining({ rule: "R2", level: "block", service: "groq" }));

    const consentOnly = base();
    consentOnly.services[1]!.ground = ["consent"];
    consentOnly.services[1]!.dpa = { status: "not_filed", accepted_on: null };
    expect(rules(consentOnly, goodEnv()).findings).toContainEqual(expect.objectContaining({ rule: "R2", level: "warn", service: "groq" }));

    consentOnly.services[1]!.dpa = { status: "not_available", accepted_on: null };
    expect(rules(consentOnly, goodEnv()).findings).toContainEqual(expect.objectContaining({ rule: "R2", level: "block", service: "groq" }));
  });

  it("R3 — a host outside the allowed countries, or a laptop, is refused", () => {
    const us = base();
    us.hosting = { provider: "hostinger", name: "Hostinger Boston", country: "US" };
    expect(rules(us, goodEnv()).findings).toContainEqual(expect.objectContaining({ rule: "R3" }));
    const laptop = base();
    laptop.hosting = { provider: "this-computer", name: "The demo laptop", country: "AE" };
    expect(rules(laptop, goodEnv()).findings).toContainEqual(expect.objectContaining({ rule: "R3", level: "block" }));
  });

  it("R4 — an AI provider must have zero retention switched on AND a date it was confirmed", () => {
    const off = base();
    off.services[1]!.controls = { zero_data_retention: false, confirmed_on: null };
    expect(rules(off, goodEnv()).findings).toContainEqual(expect.objectContaining({ rule: "R4", service: "groq" }));
    const undated = base();
    undated.services[1]!.controls = { zero_data_retention: true, confirmed_on: null };
    expect(rules(undated, goodEnv()).findings).toContainEqual(expect.objectContaining({ rule: "R4", service: "groq" }));
  });

  it("R4 — OpenRouter also needs data_collection 'deny'", () => {
    const reg = base();
    reg.services.push({
      id: "openrouter", name: "OpenRouter, Inc.", role: "processor", country: "US", personal_data: ["text"], ground: ["consent", "contract"],
      dpa: { status: "accepted", accepted_on: "2026-10-01" }, controls: { zero_data_retention: true, data_collection: "allow", confirmed_on: "2026-10-01" },
      how_to_confirm: "-", sources: [],
    });
    const findings = rules(reg, { ...goodEnv(), OPENROUTER_API_KEY: "o" }).findings;
    expect(findings).toContainEqual(expect.objectContaining({ rule: "R4", service: "openrouter" }));
  });

  it("R5 — a database hosted abroad must be named in the consent notice", () => {
    const eu = base();
    eu.hosting = { provider: "hostinger", name: "Hostinger (Lithuania)", country: "LT" };
    expect(rules(eu, goodEnv()).findings).toContainEqual(expect.objectContaining({ rule: "R5", level: "block" }));
  });

  it("R6 — production essentials: retention, sign-in, no quick tunnel, no prompt copies", () => {
    const env = { ...goodEnv() };
    delete env.RETENTION_DAYS;
    delete env.SUPABASE_URL;
    const report = rules(base(), { ...env, PUBLIC_URL: "https://funny-words.trycloudflare.com" });
    expect(report.findings.filter((f) => f.rule === "R6").map((f) => f.message)).toEqual([
      expect.stringMatching(/retention/i),
      expect.stringMatching(/Sign-in is off/),
      expect.stringMatching(/quick tunnel/),
    ]);
    expect(rules(base(), { ...goodEnv(), RETENTION_DAYS: "90" }).findings).toContainEqual(expect.objectContaining({ rule: "R6", level: "warn" }));
  });

  it("R6 — a page reached through a Cloudflare quick tunnel says so", () => {
    expect(rules(base(), goodEnv(), { requestHost: "funny-words.trycloudflare.com" }).findings).toContainEqual(
      expect.objectContaining({ rule: "R6", service: "cloudflare_quick_tunnel" }),
    );
    expect(rules(base(), goodEnv(), { requestHost: "localhost:3001", viaCloudflare: true }).findings).toContainEqual(
      expect.objectContaining({ service: "cloudflare_quick_tunnel" }),
    );
    expect(rules(base(), goodEnv(), { requestHost: "ops.freshnow.ae" }).findings).toEqual([]);
  });
});

describe("start-up", () => {
  it("production with a blocking rule refuses to start; the demo only reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-policy-"));
    const path = join(dir, "processors.json");
    const reg = base();
    reg.services[1]!.controls = { zero_data_retention: false, confirmed_on: null };
    writeFileSync(path, JSON.stringify(reg));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => checkPolicyAtStartup("test", { ...goodEnv(), COMPLIANCE_REGISTRY: path })).toThrow(/refusing to start/);
      expect(() => checkPolicyAtStartup("test", { ...goodEnv(), IS_DEMO: "true", COMPLIANCE_REGISTRY: path })).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });
});

describe("OpenRouter's routing fields follow the registry", () => {
  it("sent only once a person confirmed them", () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-or-"));
    const write = (controls: Record<string, unknown>) => {
      const path = join(dir, `${Object.keys(controls).join("-") || "none"}.json`);
      const reg = base();
      reg.services.push({
        id: "openrouter", name: "OpenRouter", role: "processor", country: "US", personal_data: [], ground: ["consent"],
        dpa: { status: "not_available", accepted_on: null }, controls, how_to_confirm: "-", sources: [],
      });
      writeFileSync(path, JSON.stringify(reg));
      return { COMPLIANCE_REGISTRY: path };
    };
    expect(openRouterDataPolicy(write({}))).toBeNull();
    expect(openRouterDataPolicy(write({ zero_data_retention: true, data_collection: "deny" }))).toEqual({ zdr: true, data_collection: "deny" });
    expect(registryPath({ COMPLIANCE_REGISTRY: "/x.json" })).toBe("/x.json");
  });
});
