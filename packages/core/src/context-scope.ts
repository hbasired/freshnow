import { nameWords, type NamedPerson } from "./people-match.js";

/**
 * Context is retrieved FOR the request, not dumped.
 *
 * A model call gets the slice of the database that one request needs — the people a message
 * names, that person's own open tasks, the last few things they said — never "everyone" or
 * "everything". Two reasons, both practical: a prompt that grows with the company eventually
 * overflows the context window (and costs more on every call), and a long list makes the model
 * worse at the one thing it is asked, because the answer is buried among rows that do not
 * matter. Every limit is a named constant here, so "how much does the model see?" has one answer.
 *
 * Deterministic and replayable: the same text and the same directory always select the same
 * people, in the same order.
 */

export const CONTEXT_LIMITS = {
  /** People offered to the model when it must pick who a message or document means. */
  colleagues: 25,
  /** A person's own open tasks, when a message may be about one of them. */
  openTasks: 30,
  /** What they said most recently, to resolve "it" and "that one". */
  recentUpdates: 8,
  /** Their open problems. */
  openBlockers: 10,
  /** Characters of a document or email handed to the model. */
  documentChars: 20_000,
} as const;

export interface ScopedPeople<T> {
  people: T[];
  /** How many there were before scoping — recorded so a truncated list is visible. */
  total: number;
  truncated: boolean;
  /** How many of the kept people the text actually names. */
  named: number;
}

/**
 * The people a text could be about, most likely first, capped.
 *
 * Everyone whose name shares a word with the text comes first (more shared words first — "Ahmed
 * Khan" before "Ahmed Ali" when the text says "Ahmed Khan"); then everyone else by name, until
 * the cap. A directory under the cap is passed whole — nothing to gain by cutting it. Above the
 * cap, a person the text never mentions may be left out; the worst case is "not in the list, tap
 * to say who" — never the wrong person, because the name check (people-match.ts) still runs.
 */
export function relevantPeople<T extends NamedPerson>(text: string, people: readonly T[], max: number = CONTEXT_LIMITS.colleagues): ScopedPeople<T> {
  const words = new Set(nameWords(text));
  const scored = people.map((p, i) => {
    const mine = nameWords(p.display_name);
    const hits = mine.filter((w) => w.length >= 2 && (words.has(w) || (w.length >= 4 && [...words].some((t) => t.length >= 3 && w.startsWith(t))))).length;
    return { p, i, hits };
  });
  const named = scored.filter((s) => s.hits > 0).length;
  if (people.length <= max) return { people: [...people], total: people.length, truncated: false, named };
  scored.sort((a, b) => b.hits - a.hits || a.p.display_name.localeCompare(b.p.display_name) || a.i - b.i);
  return { people: scored.slice(0, max).map((s) => s.p), total: people.length, truncated: true, named: Math.min(named, max) };
}
