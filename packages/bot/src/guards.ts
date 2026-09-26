/**
 * Deterministic guards on conversation state.
 *
 * Both of these exist because of one incident (gotcha G31). An unanswered `/invite` from
 * the previous evening was still waiting for a name, so the next morning's message —
 * "Assign the tasks to hemanth based on the attached pdf document." — was accepted as
 * the answer and became the display name on an invite code.
 *
 * They are rules, not model calls, deliberately: they guard questions the bot itself
 * asked, so they must behave identically every time, cost nothing, and be testable
 * without a network. Both err towards ASKING — a false "not a name" costs one tap, a
 * false "yes" mints a wrong record.
 */

/**
 * How long a half-finished question stays live. Past this, the next message is treated
 * as new intent rather than as the answer, because the person has plainly moved on.
 *
 * Thirty minutes is a judgement, not a measured figure: long enough to survive being
 * interrupted mid-flow, far short of the overnight gap that caused the incident.
 */
export const STEP_TTL_MS = 30 * 60 * 1000;

/** Has a pending question been waiting long enough that we should let it go? */
export function isStepStale(kind: string, stepAt: number | undefined): boolean {
  if (kind === "idle") return false;
  // A session written before `stepAt` existed has no age; treat it as stale rather than
  // letting it sit live forever.
  if (stepAt == null) return true;
  return Date.now() - stepAt > STEP_TTL_MS;
}

/** Words that mean the person is describing an action, not naming somebody. */
const INSTRUCTION_WORDS =
  /\b(assign|send|give|tell|ask|make|do|check|need|want|please|task|tasks|based|attached|document|pdf|file|code|new|hired|the)\b/i;

/**
 * Does this text plausibly answer "what is the new person's name?"
 *
 * A name typed at a prompt is short, is a handful of words, carries no sentence
 * punctuation or digits, and does not contain an instruction verb.
 */
export function looksLikeName(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 40) return false;

  const words = t.split(/\s+/);
  if (words.length > 4) return false;

  // Sentence punctuation, digits and address characters do not occur in a typed name.
  if (/[.!?,;:/\\@#()"']|\d/.test(t)) return false;

  return !INSTRUCTION_WORDS.test(t);
}
