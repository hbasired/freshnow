/**
 * Who does a name mean? — the deterministic check behind every "assign this to …".
 *
 * The model is good at reading "ask Rashid to fix van 2" and pointing at a colleague, but it is
 * a guess, and CLAUDE.md is plain that the model never decides WHO. With two people called
 * Ahmed it picks one of them with total confidence and nothing in its answer says so. So the
 * model's pick is never the last word: the name as written is checked against the directory,
 * in code, every time.
 *
 *   the written name matches exactly one person      → that person (even if the model picked
 *                                                      someone else — the text wins)
 *   it matches several people                         → ambiguous: ask, showing only those people
 *   it matches nobody, but the model picked someone   → unverified: a nickname, a misspelling or
 *     (or no name was written at all)                   another script ("राशिद"). Shown as a
 *                                                      suggestion to confirm, never acted on alone
 *   nothing                                           → nobody: ask
 *
 * Matching is on whole words, not substrings: "Ali" is Ahmed Ali, never Khalid or Natalie. A
 * written word of three or more letters may be the start of a name ("Rash" → Rashid). Case,
 * accents and punctuation are ignored; common honorifics are dropped ("Mr Rashid", "Priya ji").
 */

export interface NamedPerson {
  id: string;
  display_name: string;
}

// UNVERIFIED: the honorifics this workforce actually uses are assumed (English, Hindi, Malayalam
// usage in the UAE). A missing one only means a name goes to "ask", never to the wrong person.
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "sir", "madam", "ji", "bhai", "sahab", "saheb", "chetta", "chechi", "anna"]);

/** Words of a name: lower case, accents removed, letters and digits only, honorifics dropped. */
export function nameWords(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !HONORIFICS.has(w));
}

function wordMatches(written: string, word: string): boolean {
  return word === written || (written.length >= 3 && word.startsWith(written));
}

/** Everyone whose name contains every written word (whole words, or a 3+ letter start of one). */
export function matchPeopleByName<T extends NamedPerson>(written: string, people: readonly T[]): T[] {
  const q = nameWords(written);
  if (q.length === 0) return [];
  const full = q.join(" ");
  // A full-name match is the strongest signal there is: "Ahmed Ali" means Ahmed Ali even when an
  // "Ahmed Ali Khan" also exists.
  const exact = people.filter((p) => nameWords(p.display_name).join(" ") === full);
  if (exact.length > 0) return exact;
  return people.filter((p) => {
    const words = nameWords(p.display_name);
    return q.every((w) => words.some((x) => wordMatches(w, x)));
  });
}

export type PersonCheck<T extends NamedPerson> =
  | { status: "confirmed"; person: T; overridden: boolean }
  | { status: "ambiguous"; candidates: T[]; namedAs: string }
  | { status: "unverified"; suggested: T; namedAs: string | null }
  | { status: "none"; namedAs: string | null };

/**
 * Decide who a piece of work is for, from the name as written and the model's pick. Pure: the
 * same inputs give the same answer, so a routing decision can be replayed and explained.
 */
export function checkNamedPerson<T extends NamedPerson>(p: {
  namedAs: string | null | undefined;
  modelPick: T | null;
  people: readonly T[];
}): PersonCheck<T> {
  const namedAs = p.namedAs?.trim() || null;
  if (namedAs) {
    const candidates = matchPeopleByName(namedAs, p.people);
    if (candidates.length === 1) {
      const person = candidates[0]!;
      return { status: "confirmed", person, overridden: p.modelPick !== null && p.modelPick.id !== person.id };
    }
    if (candidates.length > 1) return { status: "ambiguous", candidates, namedAs };
  }
  return p.modelPick ? { status: "unverified", suggested: p.modelPick, namedAs } : { status: "none", namedAs };
}
