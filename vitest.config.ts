import { defineConfig } from "vitest/config";

// Root test runner for the whole workspace. Tests live next to the code they
// cover as `*.test.ts`. DB-backed tests run against a throwaway `freshnow_test`
// Postgres database (created + migrated in globalSetup) — never mocked, never the
// demo database.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // DB-backed tests share one Postgres; run files serially to avoid schema races.
    fileParallelism: false,
    passWithNoTests: false,
    // Several suites make REAL model and Telegram calls rather than mocking them, which
    // is deliberate — a mocked parser proves nothing about whether the parser works. The
    // 5s default is a fail for that: a document plan legitimately takes 2-4s, and this
    // machine's link to Telegram has been dropping connections intermittently.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
