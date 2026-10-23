import { describe, expect, it } from "vitest";
import type { FetchLike, TokenProvider } from "../auth.js";
import { TelevendClient } from "../client.js";
import { TelevendRefusedError } from "../errors.js";
import { OfficialStream, type StreamRecord } from "./official.js";

const BASE = "https://uat-api.televendcloud.com/televend-api";

function server(replies: { status: number; body?: unknown }[]) {
  const requests: { url: string; method: string; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, ...(init.body !== undefined && { body: init.body }) });
    const r = replies.shift();
    if (!r) throw new Error(`unexpected request ${init.method} ${url}`);
    const text = r.body === undefined ? "" : JSON.stringify(r.body);
    return { status: r.status, headers: { get: () => null }, text: async () => text };
  };
  return { fetch, requests };
}

const token: TokenProvider = { latched: false, token: async () => "t", invalidate: () => {} };
const rec = (offset: number): StreamRecord => ({ partition: 0, offset, dataType: "vends", data: { uniqueId: `v${offset}` } });

describe("OfficialStream — fetch, persist, then commit", () => {
  it("commits only after the batch was persisted", async () => {
    const s = server([{ status: 200, body: [rec(1), rec(2)] }, { status: 204 }]);
    const client = new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch: s.fetch, minIntervalMs: 0, commitOffsets: true });
    const order: string[] = [];
    const r = await new OfficialStream(client, BASE).pull("vends", async (records) => {
      order.push(`persist ${records.length}`);
    });
    expect(r).toEqual({ records: 2, committed: true });
    expect(order).toEqual(["persist 2"]);
    expect(s.requests.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual([
      "GET /televend-api/data-streaming/vends/api/v1/records",
      "POST /televend-api/data-streaming/vends/api/v1/offsets",
    ]);
  });

  it("does not commit when persisting fails, so the batch is delivered again", async () => {
    const s = server([{ status: 200, body: [rec(1)] }]);
    const client = new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch: s.fetch, minIntervalMs: 0, commitOffsets: true });
    await expect(
      new OfficialStream(client, BASE).pull("vends", async () => {
        throw new Error("database down");
      }),
    ).rejects.toThrow("database down");
    expect(s.requests).toHaveLength(1);
  });

  it("does not commit an empty batch, nor anything in demo mode", async () => {
    const empty = server([{ status: 200, body: [] }]);
    const c1 = new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch: empty.fetch, minIntervalMs: 0, commitOffsets: true });
    expect(await new OfficialStream(c1, BASE).pull("vends", async () => {})).toEqual({ records: 0, committed: false });

    const demo = server([{ status: 200, body: [rec(1)] }]);
    const c2 = new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch: demo.fetch, minIntervalMs: 0, commitOffsets: true });
    expect(await new OfficialStream(c2, BASE, { demoMode: true }).pull("vends", async () => {})).toEqual({ records: 1, committed: false });
    expect(demo.requests[0]?.url).toContain("demoMode=true");
    expect(demo.requests).toHaveLength(1);
  });

  it("cannot commit when commits are switched off", async () => {
    const s = server([{ status: 200, body: [rec(1)] }]);
    const client = new TelevendClient(token, { tenantId: 5, companyId: 3334, fetch: s.fetch, minIntervalMs: 0 });
    await expect(new OfficialStream(client, BASE).pull("vends", async () => {})).rejects.toBeInstanceOf(TelevendRefusedError);
    expect(s.requests).toHaveLength(1);
  });
});
