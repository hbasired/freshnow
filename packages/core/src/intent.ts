import { z } from "zod";
import { getServiceSql } from "./db.js";
import { llmComplete } from "./llm/client.js";
import { localDateTime } from "./time.js";

/**
 * Work out what a free-text message is actually FOR, before deciding what to do
 * with it.
 *
 * The model only CLASSIFIES — it never acts. Each intent maps to a fixed branch in
 * code, so the same message always takes the same path and the behaviour stays
 * explainable (CLAUDE.md: the LLM translates, the engine decides).
 */
export const intentSchema = z.object({
  intent: z.enum([
    "status_update", // reporting progress or a problem on work already known
    "question", // asking about stored data — needs a lookup to answer
    "new_task", // describing work that should exist as a task
    "assignment", // wants someone else to do something
    "smalltalk", // greeting, thanks, or nothing actionable
  ]),
  timeframe: z.enum(["past", "current", "future", "unknown"]),
  task_hint: z.string().max(120).optional(), // which task they seem to mean
  person_hint: z.string().max(80).optional(), // who they seem to mean
  reason: z.string().max(200), // why it was classified this way — shown in traces
});
export type Intent = z.infer<typeof intentSchema>;

const SYSTEM = `You classify a single message from a warehouse / juice-production / delivery
worker or their CEO. The message may be in English, Hindi (Devanagari or romanized) or
Malayalam. Reply with ONE JSON object in ENGLISH. Never reply in the sender's language,
never write prose outside the JSON.

intent — choose exactly one:
  status_update  Reporting how work is going: done, delayed, blocked, a problem, a
                 machine broken, stock short, someone absent, an update on a job.
  question       ASKING for information that lives in records: "what is the status of X",
                 "what did Y say", "how many blockers", "who is working on Z",
                 "show me my tasks". A question mark is a strong hint, but "tell me…"
                 and "I want to know…" count too.
  new_task       Describing work that should be recorded as a task to do — including
                 future work: "tomorrow I need to service van 2", "we should add a filter".
  assignment     Wanting SOMEONE ELSE to do something: "ask Rashid to fix the chiller",
                 "tell production to restock".
  smalltalk      Greeting, thanks, acknowledgement, or nothing actionable.

timeframe — past | current | future | unknown. Work already finished is past; work in
progress or a problem happening now is current; work intended later is future.

task_hint    the specific job or thing referred to, if named (e.g. "van 2 chiller"). Omit if none.
person_hint  the person referred to, if named. Omit if none.
reason       one short English clause explaining the classification.

If a message both reports something AND asks something, prefer "question" only when the
asking is the main point; otherwise prefer status_update.`;

// Unambiguous question openers, in the three languages the workforce uses. A message
// that clearly asks something is classified WITHOUT a model call: it is faster, free,
// and — the reason this exists — immune to a provider hiccup. A live test saw
// "how many blockers are open right now" fail classification purely because the
// provider returned malformed JSON that time.
const QUESTION_OPENERS = [
  "what", "when", "where", "which", "who", "whose", "why", "how",
  "is there", "are there", "do i", "did i", "can i", "show me", "list", "tell me",
  "kitna", "kitne", "kya", "kaun", "kab", "kahan", "batao", "dikhao",
  "ethra", "enthu", "aaru", "eppo", "evide", "parayamo",
];

/** True when a message is unambiguously a question (no model call needed). */
export function isObviousQuestion(text: string): boolean {
  return obviousQuestion(text) !== null;
}

/** Deterministic fast path. Returns null when the message is not obviously a question. */
function obviousQuestion(text: string): Intent | null {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return null;
  const opensWithQuestion = QUESTION_OPENERS.some(
    (w) => t === w || t.startsWith(w + " ") || t.startsWith(w + "'"),
  );
  // A trailing "?" alone is not enough ("chiller broken?" is a report), but a question
  // word AND a question mark, or a question word at the start, is unambiguous.
  if (!opensWithQuestion) return null;
  return {
    intent: "question",
    timeframe: "unknown",
    reason: "starts with a question word (matched without a model call)",
  };
}

/**
 * Classify a free-text message. Obvious questions are matched deterministically;
 * everything else goes to the model, bounded and schema-validated like every model call.
 */
export async function classifyIntent(text: string, correlationId?: string): Promise<Intent> {
  const fast = obviousQuestion(text);
  if (fast) return fast;

  return llmComplete({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: text },
    ],
    schema: intentSchema,
    operation: "classify_intent",
    correlationId,
    // Reasoning model: budget for the reasoning, not just the JSON (gotcha G21).
    maxTokens: 1200,
  });
}

// ── Answering an employee's own question, WITHOUT free SQL ───────────────────
// The NL→SQL path runs as the service role and bypasses row-level security, so it
// must never be handed to an employee. Their questions are answered from a fixed,
// parameterised query over their OWN rows only.

export interface OwnWorkSummary {
  tasks: { title: string; status: string }[];
  updates: { status: string; note_raw: string | null; task_title: string | null; submitted_at: Date }[];
  openBlockers: number;
}

export async function summariseOwnWork(employeeId: string): Promise<OwnWorkSummary> {
  const sql = getServiceSql();
  const tasks = await sql<{ title: string; status: string }[]>`
    select title, status from task
    where employee_id = ${employeeId} and status not in ('done','cancelled')
    order by created_at desc limit 15`;
  const updates = await sql<
    { status: string; note_raw: string | null; task_title: string | null; submitted_at: Date }[]
  >`select u.status, u.note_raw, t.title as task_title, u.submitted_at
      from task_update u left join task t on t.id = u.task_id
      where u.employee_id = ${employeeId}
      order by u.submitted_at desc limit 10`;
  const blk = await sql<{ n: number }[]>`
    select count(*)::int as n from blocker
    where raised_by = ${employeeId} and status = 'open'`;
  return {
    tasks: [...tasks],
    updates: [...updates],
    openBlockers: blk[0]?.n ?? 0,
  };
}

/** Render an employee's own work as plain text for the bot to send back. */
export function formatOwnWork(s: OwnWorkSummary): string {
  const lines: string[] = [];

  if (s.tasks.length === 0) {
    lines.push("You have no open tasks.");
  } else {
    lines.push(`Your open tasks (${s.tasks.length}):`);
    for (const t of s.tasks) lines.push(`  • ${t.title} — ${t.status}`);
  }

  if (s.openBlockers > 0) {
    lines.push("", `You have ${s.openBlockers} open blocker(s) with the CEO.`);
  }

  if (s.updates.length > 0) {
    lines.push("", "What you reported recently:");
    for (const u of s.updates.slice(0, 5)) {
      const when = localDateTime(u.submitted_at);
      const what = u.note_raw ? `"${u.note_raw}"` : "(status only)";
      lines.push(`  • ${when} — ${u.task_title ?? "general"} [${u.status}] ${what}`);
    }
  }
  return lines.join("\n");
}
