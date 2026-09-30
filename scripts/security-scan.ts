import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBytes } from "../packages/core/src/antivirus.js";

/**
 * `pnpm security:scan` — look for leaked secrets and known-vulnerable code before it ships.
 *
 *   0. the virus scanner catches the EICAR test file and passes a clean one   — when CLAMAV_HOST is set
 *   1. no secret file is tracked by git (.env, keys, database dumps)           — always
 *   2. pnpm audit: no HIGH or CRITICAL advisory in any dependency             — always (needs internet)
 *   3. gitleaks: no secret anywhere in the git HISTORY                        — when Docker is running
 *   4. OSV-Scanner: every lockfile against the OSV.dev vulnerability database — when Docker is running
 *   5. Trivy: vulnerabilities, secrets and misconfiguration (Dockerfiles, compose) — when Docker is running
 * All open source. Exits 1 if anything is found, so it can gate a deploy.
 *
 * The scanners are themselves software from the internet, and that is not hypothetical: in
 * March 2026 Trivy's own releases and Docker images were replaced with a credential stealer
 * (GHSA-69fq-xp46-6x23, CVE-2026-33634 — 0.69.4 to 0.69.6). So:
 *   - every image is pinned to a version, never `latest` (override: SCAN_*_IMAGE);
 *   - they scan a fresh CLONE of the committed code in a temp folder, mounted read-only — never
 *     this folder, whose .env holds the real keys. A poisoned scanner finds nothing worth stealing;
 *   - gitleaks, which needs no internet, runs with the network switched off.
 */

// UNVERIFIED: tags checked against release notes on 2026-09-30, not pulled from this container
// (no Docker daemon here). After a first good pull, pin by digest: docker inspect --format '{{index .RepoDigests 0}}' <image>
const IMAGES = {
  gitleaks: process.env.SCAN_GITLEAKS_IMAGE ?? "ghcr.io/gitleaks/gitleaks:v8.30.1",
  osv: process.env.SCAN_OSV_IMAGE ?? "ghcr.io/google/osv-scanner:v2.6.0",
  // The release the Trivy advisory names as the last known clean one.
  trivy: process.env.SCAN_TRIVY_IMAGE ?? "aquasec/trivy:0.69.3",
};

type Result = { name: string; status: "pass" | "fail" | "skipped"; note: string };
const results: Result[] = [];
const say = (r: Result) => {
  results.push(r);
  console.log(`${r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "–"} ${r.name}: ${r.note}`);
};

function sh(cmd: string, args: string[], inherit = false): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: inherit ? "inherit" : "pipe", windowsHide: true, shell: false });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// 0 ── the virus scanner actually catches something ─────────────────────────────
// EICAR is the industry's harmless test file: every antivirus flags it by design. It is built
// in memory and sent straight to clamd — never written to disk, where Windows Defender would
// (rightly) remove it first.
if (process.env.CLAMAV_HOST) {
  const eicar = Buffer.from(["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""), "latin1");
  const bad = await scanBytes(eicar);
  const good = await scanBytes(Buffer.from("Batch 42 passed QC"));
  say(bad.status === "infected" && good.status === "clean"
    ? { name: "virus scanner self-test", status: "pass", note: `EICAR refused (${bad.signature}); a clean file passed` }
    : { name: "virus scanner self-test", status: "fail", note: `EICAR → ${bad.status}${bad.detail ? ` (${bad.detail})` : ""}; clean → ${good.status} — is ClamAV running and done loading? docker logs freshnow-clamav` });
} else {
  say({ name: "virus scanner self-test", status: "skipped", note: "CLAMAV_HOST is not set — attachments are not virus-scanned (COMMANDS.md §7d)" });
}

// 1 ── secret files tracked by git ───────────────────────────────────────────────
const SECRET_FILE = [
  /(^|\/)\.env$/, /(^|\/)\.env\.(?!example$)[^/]+$/, /\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)id_(rsa|ed25519)/,
  /\.(dump|backup|bak|sql\.gz|rdb|aof)$/i, /(^|\/)backups\//, /(^|\/)CREDENTIALS(?!\.example\.md$)/, /service-account.*\.json$/,
];
{
  const files = sh("git", ["ls-files"]).out.split("\n").filter(Boolean);
  const bad = files.filter((f) => SECRET_FILE.some((re) => re.test(f)));
  say(bad.length
    ? { name: "secret files in git", status: "fail", note: `tracked: ${bad.join(", ")} — remove with git rm --cached, then ROTATE every key in them` }
    : { name: "secret files in git", status: "pass", note: `${files.length} tracked files, none is a secret file` });
}

// 2 ── dependency advisories ───────────────────────────────────────────────────────
{
  // Through pnpm's own entry point when run as `pnpm security:scan`: on Windows `pnpm` is a
  // .cmd shim, which Node will not start without a shell.
  const pnpmJs = process.env.npm_execpath;
  const r = pnpmJs ? sh(process.execPath, [pnpmJs, "audit", "--audit-level", "high"]) : sh("pnpm", ["audit", "--audit-level", "high"]);
  const summary = /(\d+ vulnerabilities found[\s\S]*?Severity:[^\n]*)|No known vulnerabilities found/.exec(r.out)?.[0] ?? r.out.trim().split("\n").slice(-2).join(" ");
  say({ name: "pnpm audit (high+)", status: r.code === 0 ? "pass" : "fail", note: summary.replace(/\s+/g, " ") });
}

// 3–5 ── scanners in containers ──────────────────────────────────────────────────
const docker = sh("docker", ["info", "--format", "{{.ServerVersion}}"]);
if (docker.code !== 0) {
  for (const n of ["gitleaks (git history)", "OSV-Scanner", "Trivy"]) say({ name: n, status: "skipped", note: "Docker is not running — start Docker Desktop and run again" });
} else {
  const work = mkdtempSync(join(tmpdir(), "freshnow-scan-"));
  const repo = join(work, "repo");
  try {
    const c = sh("git", ["clone", "--quiet", "--no-local", ".", repo]);
    if (c.code !== 0) throw new Error(`git clone failed: ${c.out}`);
    const mount = ["--mount", `type=bind,source=${repo},target=/repo,readonly`];

    console.log(`\n── gitleaks (${IMAGES.gitleaks}) — every commit, no network ──`);
    const g = sh("docker", ["run", "--rm", "--network", "none", ...mount,
      // The clone belongs to another user inside the container; tell git that is expected.
      "-e", "GIT_CONFIG_COUNT=1", "-e", "GIT_CONFIG_KEY_0=safe.directory", "-e", "GIT_CONFIG_VALUE_0=*",
      IMAGES.gitleaks, "git", "/repo", "--no-banner", "--redact", "--exit-code", "1"], true);
    say({ name: "gitleaks (git history)", status: g.code === 0 ? "pass" : "fail", note: g.code === 0 ? "no secrets in any commit" : "secrets found above (values redacted) — rotate them; deleting a commit does not un-leak a key" });

    console.log(`\n── OSV-Scanner (${IMAGES.osv}) ──`);
    const o = sh("docker", ["run", "--rm", ...mount, IMAGES.osv, "scan", "source", "-r", "/repo"], true);
    say({ name: "OSV-Scanner", status: o.code === 0 ? "pass" : "fail", note: o.code === 0 ? "no known vulnerabilities in the lockfiles" : "see the table above" });

    console.log(`\n── Trivy (${IMAGES.trivy}) — HIGH and CRITICAL only ──`);
    const t = sh("docker", ["run", "--rm", ...mount, "-v", "freshnow-trivy-cache:/root/.cache/",
      IMAGES.trivy, "fs", "--scanners", "vuln,secret,misconfig", "--severity", "HIGH,CRITICAL", "--exit-code", "1", "--no-progress", "/repo"], true);
    say({ name: "Trivy", status: t.code === 0 ? "pass" : "fail", note: t.code === 0 ? "nothing HIGH or CRITICAL" : "see the report above" });
  } catch (e) {
    say({ name: "container scanners", status: "fail", note: e instanceof Error ? e.message : String(e) });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skipped").length;
console.log(`\n${failed ? `✗ ${failed} check(s) found something` : "✓ nothing found"}${skipped ? ` · ${skipped} skipped` : ""}`);
process.exitCode = failed ? 1 : 0;
