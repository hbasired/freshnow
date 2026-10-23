import { z } from "zod";

/**
 * Response shapes of the Televend web app's own endpoints, written from real responses
 * captured by `pnpm televend:probe` on 2026-10-15 (web app 4.8.3). These are NOT a published
 * contract — Televend can change them — so every schema is:
 *   - strict about the few fields we depend on (a change there must fail loudly, TelevendSchemaError),
 *   - lenient about everything else (`passthrough`), so a new field never breaks the sync.
 * The raw page is kept beside the normalised row (tv_raw_page, TASK-056) for replay.
 */

const isoTimestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a timestamp");

export const pageMeta = z
  .object({
    code: z.number(),
    message: z.string().optional(),
    page: z.number().optional(),
    page_size: z.number().optional(),
    has_next_page: z.boolean().optional(),
    number_of_items: z.number().nullable().optional(),
  })
  .passthrough();

const ref = z.object({ id: z.number(), caption: z.string().nullable().optional() }).passthrough();

export const machineRow = z
  .object({
    id: z.number().int(),
    caption: z.string(),
    enabled: z.boolean(),
    pid: z.string().nullable().optional(),
    external_id: z.string().nullable().optional(),
    location: z
      .object({ id: z.number(), city: z.string().nullable().optional(), caption: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    region: ref.nullable().optional(),
    machine_type: ref.nullable().optional(),
    stock_tracking: z.boolean().optional(),
    column_count: z.number().nullable().optional(),
    device_type: z.string().nullable().optional(),
    last_refill_utc: isoTimestamp.nullable().optional(),
    last_vend_utc: isoTimestamp.nullable().optional(),
    stock: z.number().nullable().optional(),
    last_status: z.number().nullable().optional(),
    connection_details: z
      .object({ signal_strength: z.number().nullable().optional(), connection_status: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const machinesPage = z.object({ meta: pageMeta, content: z.array(machineRow) }).passthrough();

export const vendRow = z
  .object({
    vend_id: z.number().int(),
    machine_id: z.number().int(),
    machine_caption: z.string().nullable().optional(),
    location_caption: z.string().nullable().optional(),
    timestamp: isoTimestamp,
    product_caption: z.string().nullable().optional(),
    payment_type: z.number().int(),
    payment_type_caption: z.string().nullable().optional(),
    /** null when the account lacks the vend-revenue permission (seen 2026-10-15). */
    value: z.number().nullable().optional(),
    column_index: z.number().int().nullable().optional(),
    quantity: z.number().int(),
    price_list_number: z.number().int().nullable().optional(),
    televend_device_vend_id: z.number().int().nullable().optional(),
  })
  .passthrough();

export const vendsPage = z.object({ meta: pageMeta, content: z.array(vendRow) }).passthrough();

export const vendAggregates = z
  .object({
    total_revenue: z.number().nullable(),
    number_of_sale_vends: z.number(),
    total_quantity: z.number(),
  })
  .passthrough();

export const eventRow = z
  .object({
    id: z.number().int(),
    level: z.number().int(),
    type: z.union([z.string(), z.number()]),
    source: z.number().int(),
    start_time: isoTimestamp,
    counter: z.number().int().nullable().optional(),
    name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    resolved_time: isoTimestamp.nullable().optional(),
    machine: z
      .object({ id: z.number().int(), caption: z.string().nullable().optional(), location_caption: z.string().nullable().optional() })
      .passthrough(),
    assigned_users: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const eventsPage = z.object({ meta: pageMeta, content: z.array(eventRow) }).passthrough();

export const refillLog = z
  .object({
    timestamp: isoTimestamp,
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    role_name: z.string().nullable().optional(),
    column_index: z.number().int().nullable().optional(),
    is_product: z.boolean().nullable().optional(),
    caption: z.string().nullable().optional(),
    fill_type: z.number().int(),
    quantity_change: z.number(),
    quantity: z.number().nullable().optional(),
    max_quantity: z.number().nullable().optional(),
    source: z.number().int().nullable().optional(),
  })
  .passthrough();

export const refillDetails = z
  .object({
    meta: pageMeta,
    content: z.array(
      z
        .object({
          new_route_id: z.unknown().optional(),
          new_route_name: z.unknown().optional(),
          logs: z.array(refillLog).default([]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const machineStatusNow = z
  .object({
    meta: pageMeta,
    content: z
      .object({
        details: z
          .object({
            count_all: z.number(),
            count_ok: z.number(),
            count_warn: z.number(),
            count_err: z.number(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * The signed-in account's permission flags. Only the flag names and true/false are used — the
 * response also carries the person's name, which is never stored or printed.
 */
export const accessControl = z
  .object({
    meta: pageMeta,
    content: z
      .object({
        tenant_id: z.number().optional(),
        role_caption: z.string().optional(),
        companies: z.array(z.object({ cloud_id: z.number(), timezone: z.string().optional() }).passthrough()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
