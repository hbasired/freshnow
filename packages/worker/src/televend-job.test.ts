import { describe, expect, it } from "vitest";
import { televendSyncConfig, televendSyncMinutes } from "./televend-job.js";

describe("when the worker schedules the Televend sync", () => {
  it("only in bridge mode with credentials — nothing configured means no schedule", () => {
    expect(televendSyncConfig({})).toBeNull();
    expect(televendSyncConfig({ TELEVEND_MODE: "files" })).toBeNull();
    expect(televendSyncConfig({ TELEVEND_MODE: "bridge", TELEVEND_USERNAME: "user@example.invalid", TELEVEND_PASSWORD: "x" })?.mode).toBe("bridge");
    // The official transport is a stream consumer, wired when Televend issues credentials.
    expect(televendSyncConfig({ TELEVEND_MODE: "official", TELEVEND_CLIENT_ID: "a", TELEVEND_CLIENT_SECRET: "b" })).toBeNull();
  });

  it("refuses half a configuration loudly, without echoing any value", () => {
    expect(() => televendSyncConfig({ TELEVEND_MODE: "bridge", TELEVEND_USERNAME: "user@example.invalid" })).toThrow(
      /bridge mode needs TELEVEND_USERNAME and TELEVEND_PASSWORD/,
    );
    try {
      televendSyncConfig({ TELEVEND_MODE: "bridge", TELEVEND_PASSWORD: "s3cret-value" });
    } catch (e) {
      expect(String(e)).not.toContain("s3cret-value");
    }
  });

  it("every 10 minutes by default, bounded to 2–120", () => {
    expect(televendSyncMinutes({})).toBe(10);
    expect(televendSyncMinutes({ TELEVEND_SYNC_MINUTES: "15" })).toBe(15);
    expect(televendSyncMinutes({ TELEVEND_SYNC_MINUTES: "0" })).toBe(10);
    expect(televendSyncMinutes({ TELEVEND_SYNC_MINUTES: "999" })).toBe(10);
    expect(televendSyncMinutes({ TELEVEND_SYNC_MINUTES: "soon" })).toBe(10);
  });
});
