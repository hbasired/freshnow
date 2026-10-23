import { z } from "zod";
import { TelevendClient } from "../client.js";

/**
 * Official transport — Televend's documented Data-Streaming API (devportal.televendcloud.com,
 * specs vends.yaml / events.yaml / fill-events.yaml / cash-collection.yaml v1.9.0, read
 * 2026-10-15). It is a consumer, not a query: each call to `/records` returns the messages after
 * the last COMMITTED offset, and only a commit moves on. The documented loop is:
 *
 *     fetch → persist durably → commit     (repeat every few minutes)
 *
 * Persisting before committing makes delivery at-least-once: a crash between the two re-delivers
 * the batch, and the mirror's unique keys (TASK-056) absorb the repeat. Streams keep 7 days.
 *
 * STATUS: built against the specs and tested with a stub; NOT exercised against Televend —
 * FreshNow has no API client yet (requested from Televend IT; see TASK-055 drafts). `demoMode`
 * (dummy but well-formed data) is the first live check once credentials arrive.
 */

export const STREAMS = ["vends", "vending-events", "fill-events", "cash-collections", "cashbag-countings"] as const;
export type StreamType = (typeof STREAMS)[number];

/** The envelope every stream uses: { partition, offset, dataType, data }. */
export const streamRecord = z
  .object({
    partition: z.number().int(),
    offset: z.number().int(),
    dataType: z.string().optional(),
    data: z.unknown(),
  })
  .passthrough();
export type StreamRecord = z.infer<typeof streamRecord>;

export const streamOffset = z
  .object({
    dataType: z.string().optional(),
    partition: z.number().int(),
    offset: z.number().int().nullable().optional(),
    messagesBehind: z.number().int().nullable().optional(),
    messagesCount: z.number().int().nullable().optional(),
  })
  .passthrough();

/** One stream batch is capped; a consumer that needs more simply loops (bounded by the caller). */
const MAX_RECORDS_PER_BATCH = 10_000;

export class OfficialStream {
  constructor(
    private readonly client: TelevendClient,
    private readonly baseUrl: string,
    private readonly opts: { demoMode?: boolean } = {},
  ) {}

  private url(path: string): string {
    const u = new URL(`${this.baseUrl}${path}`);
    if (this.opts.demoMode) u.searchParams.set("demoMode", "true");
    return u.toString();
  }

  /** How far behind we are, per partition. A pure read. */
  async offsets(type: StreamType): Promise<z.infer<typeof streamOffset>[]> {
    return this.client.get(this.url(`/data-streaming/${type}/api/v1/offsets`), z.array(streamOffset));
  }

  /**
   * One batch: fetch, hand to `persist` (which must be durable — e.g. a committed DB
   * transaction), and only then commit. If `persist` throws, nothing is committed and the same
   * records come back next time.
   */
  async pull(type: StreamType, persist: (records: StreamRecord[]) => Promise<void>): Promise<{ records: number; committed: boolean }> {
    const records = await this.client.get(this.url(`/data-streaming/${type}/api/v1/records`), z.array(streamRecord));
    if (records.length > MAX_RECORDS_PER_BATCH) {
      throw new Error(`stream ${type} returned ${records.length} records in one batch — refusing to process more than ${MAX_RECORDS_PER_BATCH}`);
    }
    if (records.length === 0) return { records: 0, committed: false };
    await persist(records);
    // The demo stream is dummy data; its offsets are not ours to move.
    if (this.opts.demoMode) return { records: records.length, committed: false };
    await this.client.commitOffsets(this.url(`/data-streaming/${type}/api/v1/offsets`));
    return { records: records.length, committed: true };
  }
}
