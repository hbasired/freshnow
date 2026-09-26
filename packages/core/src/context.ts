import { z } from "zod";
import { getServiceSql } from "./db.js";
import { llmComplete } from "./llm/client.js";
import { localDateTime } from "./time.js";

/**
 * Context engineering for free-text messages.
 *
 * A message like "the chiller one is fixed now" means nothing on its own. It only
 * resolves against what this person already has open, what they said recently, and
 * who they work with. So we:
 *
 *   1. RETRIEVE a bounded slice of that person's real world (tasks, recent words,
 *      open blockers, colleagues),
 *   2. give the model that slice and ask it to RESOLVE the references,
 *   3. VALIDATE every id it returns against the slice we supplied.
 *
 * Step 3 is the important one. The model can only choose from ids we handed it, so it
 * cannot invent a task or a person — the same grounding principle as the numeric
 * sanity gate. If it returns anything unknown we drop the reference rather than act
 * on it. Everything after resolution is ordinary deterministic code.
 *
 * Bounded by design (CLAUDE.md rule 4): 15 tasks, 8 recent updates, 25 colleagues.
 */

const MAX_TASKS = 15;
const MAX_UPDATES = 8;
const MAX_COLLEAGUES = 25;

export interface ContextTask {
  id: string;
  title: string;
  status: string;
  created_at: Date;
}
export interface ContextUpdate {
  task_id: string | null;
  task_title: string | null;
  status: string;
  note_raw: string | null;
  submitted_at: Date;
}
export interface ContextPerson {
  id: string;
  display_name: string;
  department: string | null;
}

export interface MessageContext {
  employeeId: string;
  displayName: string;
  tasks: ContextTask[];
  recentUpdates: ContextUpdate[];
  openBlockers: { id: string; category: string | null; severity: string | null; summary: string | null }[];
  colleagues: ContextPerson[];
}

/** Retrieve the bounded slice of this person's world that a message might refer to. */
export async function loadMessageContext(employeeId: string): Promise<MessageContext> {
  const sql = getServiceSql();

  const me = await sql<{ display_name: string }[]>`
    select display_name from employee where id = ${employeeId}`;

  const tasks = await sql<ContextTask[]>`
    select id, title, status, created_at from task
    where employee_id = ${employeeId} and status not in ('done','cancelled')
    order by created_at desc limit ${MAX_TASKS}`;

  const recentUpdates = await sql<ContextUpdate[]>`
    select u.task_id, t.title as task_title, u.status, u.note_raw, u.submitted_at
    from task_update u left join task t on t.id = u.task_id
    where u.employee_id = ${employeeId}
    order by u.submitted_at desc limit ${MAX_UPDATES}`;

  const openBlockers = await sql<
    { id: string; category: string | null; severity: string | null; summary: string | null }[]
  >`select id, category, severity, coalesce(affected_asset, risk) as summary
      from blocker where raised_by = ${employeeId} and status = 'open'
      order by raised_at desc limit 10`;

  // Colleagues are needed so "ask Rashid to look at it" can resolve to a real person.
  const colleagues = await sql<ContextPerson[]>`
    select id, display_name, department from employee
    where status = 'active' and id <> ${employeeId}
    order by is_synthetic, display_name limit ${MAX_COLLEAGUES}`;

  return {
    employeeId,
    displayName: me[0]?.display_name ?? "unknown",
    tasks: [...tasks],
    recentUpdates: [...recentUpdates],
    openBlockers: [...openBlockers],
    colleagues: [...colleagues],
  };
}

// ── What the model is allowed to return ──────────────────────────────────────
/**
 * An index the model may omit, send as a string, or send out of range. Anything not a
 * valid in-range integer is normalised to 0 ("none"), which is always the safe reading.
 * Normalising BEFORE validation means a missing field can never discard the message —
 * a live run failed only because "assignee_index" was absent when nobody was named.
 */
const indexField = (max: number): z.ZodType<number> =>
  // z.preprocess infers as `unknown` here, so the output type is stated explicitly.
  // The preprocessor guarantees a valid integer, so this is a narrowing, not a lie.
  z.preprocess((v) => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max ? n : 0;
  }, z.number().int()) as z.ZodType<number>;

/**
 * One message can carry several distinct work items ("tell Rashid to fix van 2 and
 * ask Priya to restock the Marina machine"). Capped, because an unbounded list from a
 * model becomes an unbounded number of writes (CLAUDE.md rule 4).
 */
const MAX_ITEMS = 8;

const itemSchema = z.object({
  task_index: indexField(MAX_TASKS),
  new_task_title: z.string().max(200).nullish(),
  assignee_index: indexField(MAX_COLLEAGUES),
});

// Deliberately liberal in what it accepts: models legitimately omit fields that do
// not apply.
const resolutionSchema = z.object({
  // Strict on these two: if the model returns something unrecognisable here, the parse
  // throws and the caller falls back to treating the message as a status update —
  // which stores their words. Same safe outcome, without fighting type inference.
  intent: z.enum(["status_update", "question", "new_task", "assignment", "smalltalk"]),
  timeframe: z.enum(["past", "current", "future", "unknown"]),
  /** Index into the supplied task list (1-based); 0 or absent = none of them fit. */
  task_index: indexField(MAX_TASKS),
  /** Title to use when this should become a NEW task. */
  new_task_title: z.string().max(200).nullish(),
  /** Index into the supplied colleague list (1-based); 0 or absent = nobody named. */
  assignee_index: indexField(MAX_COLLEAGUES),
  /** Every distinct work item in the message. Absent = the single item above. */
  items: z.array(itemSchema).max(MAX_ITEMS).nullish(),
  reason: z.string().max(400).nullish(),
});

/** One piece of work found in a message, with every reference already validated. */
export interface ResolvedItem {
  /** An EXISTING task this item is about, already validated against the context. */
  task: ContextTask | null;
  /** A title to create a new task with, when this item describes new work. */
  newTaskTitle: string | null;
  /** A REAL colleague this item should be assigned to, already validated. */
  assignee: ContextPerson | null;
}

export interface ResolvedMessage {
  intent: z.infer<typeof resolutionSchema>["intent"];
  timeframe: z.infer<typeof resolutionSchema>["timeframe"];
  /**
   * Every work item in the message, in the order stated. Always at least one entry,
   * so a caller can loop without a special case for the single-item message.
   */
  items: ResolvedItem[];
  /** The first item, flattened. Kept because most messages carry exactly one. */
  task: ContextTask | null;
  newTaskTitle: string | null;
  assignee: ContextPerson | null;
  reason: string;
}

function renderContext(ctx: MessageContext): string {
  const lines: string[] = [`You are helping ${ctx.displayName}.`];

  lines.push("", "THEIR OPEN TASKS (choose task_index from this numbered list, 0 = none fit):");
  if (ctx.tasks.length === 0) lines.push("  (none)");
  ctx.tasks.forEach((t, i) => lines.push(`  ${i + 1}. ${t.title} [${t.status}]`));

  if (ctx.recentUpdates.length > 0) {
    lines.push("", "WHAT THEY RECENTLY REPORTED (most recent first — use this to understand references):");
    for (const u of ctx.recentUpdates) {
      const when = localDateTime(u.submitted_at);
      lines.push(
        `  - ${when} [${u.status}] on "${u.task_title ?? "general"}": ` +
          (u.note_raw ? `"${u.note_raw.slice(0, 160)}"` : "(status only, no words yet)"),
      );
    }
  }

  if (ctx.openBlockers.length > 0) {
    lines.push("", "THEIR OPEN PROBLEMS:");
    for (const b of ctx.openBlockers) {
      lines.push(`  - ${b.severity ?? "?"} ${b.category ?? "?"}${b.summary ? ": " + b.summary : ""}`);
    }
  }

  lines.push("", "COLLEAGUES (choose assignee_index from this numbered list, 0 = nobody named):");
  if (ctx.colleagues.length === 0) lines.push("  (none)");
  ctx.colleagues.forEach((p, i) =>
    lines.push(`  ${i + 1}. ${p.display_name}${p.department ? " (" + p.department + ")" : ""}`),
  );

  return lines.join("\n");
}

const SYSTEM = `You interpret ONE message from a warehouse / juice-production / delivery worker,
using the context supplied. The message may be English, Hindi (Devanagari or romanized) or
Malayalam. Reply with ONE JSON object, values in ENGLISH, no prose outside the JSON.

Fields:
  intent        status_update | question | new_task | assignment | smalltalk
                  status_update - reporting progress or a problem on work
                  question      - ASKING for information held in records
                  new_task      - describing work that should become a task (incl. future work)
                  assignment    - wanting SOMEONE ELSE to do something
                  smalltalk     - greeting/thanks/nothing actionable
  timeframe     past | current | future | unknown
  task_index    Which of THEIR OPEN TASKS this message is about. Use the number from the
                list. Use 0 only if none of them plausibly fit.
                IMPORTANT: a message often refers to a task listed above WITHOUT naming it
                exactly — "the chiller one", "that machine job", "it is fixed now", or simply
                continuing what they last reported. Match on meaning, not exact words. Their
                recent reports tell you what they have been working on.
  new_task_title  The WORK ITSELF, as a short task title — for intent new_task OR assignment.
                  Strip the instruction wrapper and the person's name. Write what someone
                  would put on a to-do list.
                    "Assign hemanth the task of demo presentation" -> "Demo presentation"
                    "ask Rashid to fix the van 2 chiller"          -> "Fix the van 2 chiller"
                    "tomorrow I need to service the bottling machine" -> "Service the bottling machine"
                  NEVER echo the sentence back as the title.
  assignee_index  Which COLLEAGUE the work is for, when intent is assignment. 0 if nobody named.
                  Match on first name, nickname or partial name.
  items         ONE MESSAGE CAN CONTAIN SEVERAL SEPARATE WORK ITEMS. Return an array with
                one entry per distinct item, each with its own task_index,
                new_task_title and assignee_index. Split on "and", "also", commas,
                bullet points and new lines — but only when they are genuinely
                DIFFERENT pieces of work, never to chop one sentence in half.
                  "tell Rashid to fix van 2 and ask Priya to restock the Marina machine"
                    -> [{new_task_title:"Fix van 2", assignee_index:<Rashid>},
                        {new_task_title:"Restock the Marina machine", assignee_index:<Priya>}]
                  "chiller is fixed and I finished the delivery"
                    -> [{task_index:<chiller>}, {task_index:<delivery>}]
                For a single-item message return one entry. Maximum ${MAX_ITEMS}.
                Also fill the top-level task_index/new_task_title/assignee_index with
                the FIRST item, for compatibility.
  reason        One short English clause saying why — this is shown to auditors.

Never invent a task or a person. If nothing in the lists fits, use 0.`;

/**
 * Resolve what a message refers to. Every id the model picks is validated against the
 * context we supplied, so an out-of-range or invented reference is dropped, not acted on.
 */
export async function resolveMessage(
  text: string,
  ctx: MessageContext,
  correlationId?: string,
): Promise<ResolvedMessage> {
  const out = await llmComplete({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `${renderContext(ctx)}\n\nMESSAGE:\n${text}` },
    ],
    schema: resolutionSchema,
    operation: "resolve_context",
    correlationId,
    // Reasoning models spend tokens before answering; budget for that (gotcha G21).
    maxTokens: 1400,
  });

  // Grounding: an index is only honoured if it actually points into the list we gave
  // it, so an out-of-range or invented reference resolves to null rather than to some
  // other person's task.
  const resolveOne = (it: z.infer<typeof itemSchema>): ResolvedItem => ({
    task:
      it.task_index >= 1 && it.task_index <= ctx.tasks.length
        ? ctx.tasks[it.task_index - 1]!
        : null,
    newTaskTitle: it.new_task_title?.trim() ? it.new_task_title.trim() : null,
    assignee:
      it.assignee_index >= 1 && it.assignee_index <= ctx.colleagues.length
        ? ctx.colleagues[it.assignee_index - 1]!
        : null,
  });

  const flat = resolveOne({
    task_index: out.task_index,
    new_task_title: out.new_task_title,
    assignee_index: out.assignee_index,
  });

  // Prefer the array when the model split the message; drop entries that resolved to
  // nothing at all, since acting on them would create an empty task.
  const listed = (out.items ?? []).map(resolveOne).filter((i) => i.task ?? i.newTaskTitle ?? i.assignee);
  const items = listed.length > 0 ? listed : [flat];

  return {
    intent: out.intent,
    timeframe: out.timeframe,
    items,
    task: items[0]!.task,
    newTaskTitle: items[0]!.newTaskTitle,
    assignee: items[0]!.assignee,
    reason: out.reason ?? "",
  };
}
