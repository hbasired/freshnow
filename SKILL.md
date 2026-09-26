---
name: deterministic-query
description: "The anti-hallucination architecture for querying data with an LLM in the FreshNow platform — why the model must translate rather than compute, the semantic layer with column notes and foreign-key purpose strings (including self-joins), schema pruning, MAX_ROWS caps, bounded tool-calling loops, deterministic numeric-sanity and grounding gates, critic and cross-validator escalation, completeness checking, and abstention. Use this skill whenever building or changing anything that turns a question into a database query, whenever an LLM reads or reports data, whenever writing validation or confidence logic, whenever editing semantic/schema.yaml, and whenever a tool loop, retrieval step, or report generator is involved. Also use it any time a feature would have an LLM count, sum, aggregate, rank, or summarise rows — that is exactly the case this skill exists to prevent."
---

# Deterministic Query & Validation

## The core problem

A transformer is a sequence model. A table is a two-dimensional object with exact
semantics. Every practical failure of "LLM reads my data" traces to that mismatch:

| What a table is | What a transformer does | Consequence |
|---|---|---|
| **Two-dimensional** — a cell means something because of its row *and* its column header | Flattens to 1-D. A value can end up hundreds of tokens from the header defining it | Column–value binding degrades as tables get wider |
| **Row order is meaningless** — rows are a set | Positional encodings make position meaningful | Answers become sensitive to row order, which carries no information |
| **Arithmetic is exact** — a sum is an algorithm with a carry | Approximates arithmetic from token patterns; tokenisation splits numbers unpredictably | Plausible totals that are quietly wrong |
| **Aggregation needs completeness** — `COUNT` must see every qualifying row | Attention is a soft weighting designed to *focus* | Focus and completeness are opposite objectives |
| **A number is right or wrong** | Generates the most probable next token | No internal distinction between "I read this" and "this looks right" |

The fourth row is the deepest. Attention exists to decide what matters *more*;
aggregation requires treating every qualifying row as equally mandatory. Ask a
salience mechanism for exhaustiveness and it will produce **an estimate shaped like an
answer**.

*(This framing is drawn from the TechNova reference material supplied with the
project, which attributes it to a lecture transcript. Treat the reasoning as sound and
the quotations as unverified — see `HONESTY-AND-ACCURACY.md`.)*

## The resolution

Stop asking the model to *be* the engine. Give it the one job it is built for —
translation.

```
natural language → [ LLM: translate ] → SQL
                                         ↓
                  [ Postgres: compute exactly, over every row ]
                                         ↓
      answer ← [ LLM: narrate ] ← ≤ 50 rows
```

**The model never counts anything.** It writes `COUNT(*)` and reads back one number.

Three constraints follow, and all three are mandatory:

1. **Translate, don't compute** — bounded tool loop; the model emits queries, never totals.
2. **Give it meaning, not just types** — the semantic layer, so translation has something to translate *into*.
3. **Keep both ends small** — schema pruning on the way in, row cap on the way back.

---

## 1. The semantic layer (`semantic/schema.yaml`)

Hand-maintained. Reflection gives you types; only a human gives you meaning.

```yaml
tables:
  blocker:
    description: >
      A reported obstruction preventing an employee from completing a task.
      Raised by the employee, routed to a resolver by category, escalated on SLA breach.
    columns:
      severity:
        type: text
        notes: >
          low | medium | high | critical. "critical" means production stopped,
          cold chain broken, or a safety issue. NOT a priority ranking set by the CEO —
          that is task.priority. Assigned by the classifier, correctable by a manager.
      status:
        type: text
        notes: >
          open | acknowledged | resolved | cancelled. An "open" blocker is one nobody
          has accepted yet. "acknowledged" means a resolver took it but hasn't fixed it.
          Count open+acknowledged when asked "how many blockers are outstanding".
      raised_at:
        type: timestamptz
        notes: >
          When the employee reported it, not when the system parsed it. Use this for
          age and SLA calculations, never created_at.

    foreign_keys:
      - column: raised_by
        references: employee.id
        purpose: >
          Who reported the problem. Use this join for "which employees are blocked"
          and "who reports the most equipment problems".
      - column: assigned_resolver
        references: employee.id
        purpose: >
          Who is responsible for fixing it. NOTE: blocker joins employee TWICE —
          once via raised_by and once via assigned_resolver. A question naming both
          the reporter and the fixer requires two aliased joins to the same table.

  employee:
    foreign_keys:
      - column: manager_id
        references: employee.id
        purpose: >
          SELF-REFERENTIAL. The employee's line manager, who is also an employee.
          Any question about managers, reporting lines, or "escalate to my manager"
          requires joining employee to ITSELF with two aliases:
            FROM employee e JOIN employee m ON e.manager_id = m.id
          Nothing in the column types signals this. Recursive CTE for full hierarchy.
```

### Why the `notes` field matters

Real schemas are full of internal nicknames, legacy abbreviations, and codes whose
meaning lives in someone's head. A model asked about "outstanding problems" will look
for a column called `outstanding`, not find one, and either fail loudly or — worse —
pick something plausible and wrong. The `notes` field is the dictionary, written once.

### Why the `purpose` field matters

The reference material's teaser: given an `employee` table with `id`, `name`, and
`manager_id`, find employees whose name matches their own manager's name.

```sql
SELECT e.name
FROM employee e
JOIN employee m ON e.manager_id = m.id   -- the same table, twice
WHERE e.name = m.name;
```

Nothing in the column types tells you a self-join is required. That is relational
reasoning about what the data *means*, and it is exactly the case the user flagged:
**a model referring to the same table or ID twice is where loops and wrong joins
start.** The `purpose` string is how the model is told which join path a question calls for.

### Maintenance is part of the task

A semantic layer written once and left alone rots, and schema drift silently degrades
query accuracy until someone notices. **When a migration changes a table, updating
`schema.yaml` is part of that migration's task**, not a follow-up. Add a CI check that
fails if a table exists in the database but not in `schema.yaml`.

### The semantic layer as a scope guard

Before executing anything, check whether the data exists at all. Checking scope is
cheaper and safer than discovering mid-query that the data was never there. If it
isn't in the semantic layer, the correct answer is:

> "I don't have that information."

**Abstention must be reachable.** A system that always answers is a system that
sometimes lies.

---

## 2. Schema pruning

Never paste the whole schema into a prompt. Select only the tables a question needs,
based on entities extracted in the intent step, plus their immediate foreign-key
neighbours.

```ts
export function buildSchemaContext(entities: string[]): string {
  const tables = resolveTables(entities);           // from the semantic layer
  const withNeighbours = expandOneHop(tables);      // FK-adjacent tables only
  return renderYaml(withNeighbours);                // notes + purpose included
}
```

Keep `describe_table` available as a tool so the rest stays reachable on demand. The
reference implementation reported pruning its schema from roughly 7,449 tokens to
about 1,559–2,670 — **that is their measurement on their corpus, not a target to hit**.
Measure your own.

---

## 3. Bounded tool loops

This is the direct fix for "LLMs go into loops and never return."

```ts
const MAX_ITERATIONS = 8;          // SQL agent
const MAX_RETRIEVAL_ITERATIONS = 6;

for (let i = 0; i < MAX_ITERATIONS; i++) {
  const step = await model.next(messages);
  if (step.type === "final") return step;
  const result = await runTool(step.tool, step.args);   // itself bounded
  messages.push(result);
}

// Cap reached — do NOT loop again, do NOT silently return a guess
return {
  ok: false,
  reason: "iteration_cap_reached",
  partial: lastGoodResult,
  message: "I couldn't complete this query. Here's what I have so far.",
};
```

Rules:

- **Hard cap, always.** No "just one more retry if it looks close."
- **Cap reached is a reportable outcome**, not an error to swallow and not a reason to
  fabricate. Surface it to the user and log it.
- **Per-task token budget** with a circuit breaker on top of the iteration cap — a
  loop can be short and still expensive.
- **Detect repetition:** if the model emits the same tool call with the same arguments
  twice in a row, break immediately. That is a loop signature, not progress.
- **Every tool call is logged** with its arguments and result, so a stuck loop is
  visible in the trace rather than inferred from a hanging request.

### The five database tools

The model reaches the database only through these, never through string interpolation:

| Tool | Purpose |
|---|---|
| `list_tables` | Discover what exists |
| `describe_table` | Columns, types, and **notes** for one table |
| `sample_rows` | See real values before committing to a filter |
| `count_rows` | Cheap cardinality check |
| `run_sql` | Execute — **read-only connection**, results capped |

Two guardrails are non-negotiable: the connection is opened **read-only** so
`INSERT`/`UPDATE`/`DROP` fail at the engine, and results are capped.

---

## 4. `MAX_ROWS = 50`

Not for tidiness. An unbounded result set is the fastest way to blow the context
window — and the second context problem after the schema.

```ts
export const MAX_ROWS = 50;

// If a query would return more, push the aggregation into SQL instead of hauling
// rows into the model and asking it to add them up.
```

When a result is truncated, **say so in the answer**. A silently truncated list read
as complete is exactly the confident-wrong-number failure.

---

## 5. Deterministic gates — run before any LLM validation

Two gates, pure code, no model. No latency, no possibility of the judge hallucinating.

### Numeric sanity gate

If the answer states numbers and a query result exists, **at least one of those
numbers must literally appear in the returned rows.**

```ts
function numericSanityGate(draft: string, rows: Row[]): GateResult {
  const claimed = extractNumbers(draft);                    // regex, handles formatting
  if (claimed.length === 0) return { ok: true };
  if (rows.length === 0) return { ok: false, reason: "numbers stated with no result set" };

  const present = new Set(rows.flatMap(r => Object.values(r)).map(normaliseNumber));
  const grounded = claimed.some(n => present.has(normaliseNumber(n)));

  return grounded
    ? { ok: true }
    : { ok: false, reason: "no stated number appears in the query result" };
}
```

This catches the classic failure: correct query, correct rows, **invented total**.

### Grounding gate

If the answer makes a claim about a policy, a rule, an SLA, or a food-safety
requirement, it must cite a source record. Maintain a lexicon of policy terms
(`cold chain`, `HACCP`, `SLA`, `retention`, `expiry`, `escalation policy`, …); if a
term appears in the question or the answer, a citation is required.

### Escalation, not failure

A failed gate does not fail the request. It escalates:

```
gates → [pass] → Critic → [confident] → Finalise
      → [fail] → Cross-Validator (re-derive by a DIFFERENT method)
                 → [agrees] → Finalise
                 → [disagrees] → Arbiter → Finalise
```

**Cost is paid in proportion to doubt.** A simple, confident answer runs the cheap
path. Only a doubtful one pays for cross-validation.

---

## 6. Cross-validation must use a different method

Asking the same model to "check your work" on the same evidence mostly reproduces the
same reasoning and the same error. The cross-validator is instructed to re-derive by a
**different** route:

- Recompute an aggregate a different way (subquery instead of join; group and sum
  instead of a direct count).
- Cross-check a distribution for internal consistency — if the parts should sum to a
  known total, verify that they do.
- Fetch corroborating records rather than re-reading the same ones.

It emits a complete, self-contained replacement answer when it disagrees, and the
finaliser picks the higher-confidence verdict.

---

## 7. Completeness is a separate axis from correctness

An answer can be entirely true and still omit the thing that changes the decision.

The completeness checker is a **pure recall gate**: it never re-judges correctness, it
only asks whether a relevant known fact was left out. For FreshNow that means, for
example: a blocker summary that omits an open critical blocker is incomplete even if
every word of it is true.

Keep the fact set bounded (a cap of ~20, curated facts ranked above auto-extracted
ones) to keep the prompt bounded and avoid diluting attention across competing facts.

---

## 8. Clarification and read-back

Ambiguity resolved *before* execution is much cheaper than a confidently wrong answer
delivered after it.

- **Clarification:** fires only when a clarity score is low. Picks the **single**
  highest-severity ambiguity and asks **one** question — never a barrage. **Max 3
  rounds**, then proceeds with a best guess flagged low-confidence.
- **Read-back:** for complex questions (a join, an aggregation, a top-N, two or more
  filters, or a time range), state the resolved interpretation in one sentence and
  wait: *"To confirm — open blockers, severity high or critical, raised this week,
  grouped by department. Run?"*

One small model call to avoid executing an expensive, confidently wrong interpretation
is a good trade.

---

## 9. Retrieval, when it applies (Phase 3+)

Once there are policy documents, SOPs, or R&D notes to search:

- **Hybrid retrieval.** Dense embeddings alone miss exact identifiers (a batch code
  like `BATCH-2026-0847` has no useful semantic neighbourhood). Keyword search alone
  misses paraphrase. Run both.
- **Reciprocal Rank Fusion** to combine them: `score = Σ 1/(k + rank_i)`, k=60. RRF
  fuses on *rank*, not score, which is what makes it robust — cosine similarities and
  BM25 scores are not on comparable scales.
- **Cross-encoder rerank** the survivors; send the top few to the model.
- **Contextual prefix at ingestion.** Prepend a sentence situating each chunk in its
  parent document *before* embedding, so a chunk stays interpretable once pulled out
  of the middle of that document and shown alone.

The reason retrieval exists at all is the **lost-in-the-middle** effect: attention over
a long context is not uniform, and material in the middle is recalled far less
reliably than material at either end. This is precisely the user's concern about
"LLMs not querying information from in-between rows." **Never solve it by pasting more
context — solve it by retrieving less, better.**

### Structured data is never embedded

Chunking a table destroys row semantics. "How many blockers are open?" is not a
similarity problem — it is a complete scan with a filter and a count. If qualifying
rows are spread across nine chunks and you retrieve five, you don't get a slightly
worse answer, you get a **confidently wrong number with no signal that anything was
missed**. Countable questions go to SQL. Always.

---

## 10. Onboarding new data (Phase 3+)

When employees or managers can upload data — a product list, a machine inventory, a
supplier sheet — the semantic layer stops matching reality and the system starts
hallucinating on garbage.

The pattern to implement:

1. On upload, run micro-queries against the uploaded data to profile it (types,
   distinct counts, null rates, sample values) **before** it reaches the database.
2. Crawl the existing semantic layer for similar columns and infer meanings.
3. Present only the **genuinely ambiguous residue** to a human, with editable fields:
   *"You uploaded 12 columns. We think `qty_rem` means remaining quantity in units.
   Correct?"*
4. Write the confirmed meanings back into `schema.yaml`.

Human attention is the scarce resource. Spend it on the residue, not on all twelve
columns.

---

## Checklist for any query-producing feature

- [ ] The model writes a query; it never produces a number it didn't read from a result
- [ ] The DB connection is read-only
- [ ] `MAX_ROWS` is enforced and truncation is disclosed in the answer
- [ ] The tool loop has a hard iteration cap and a repetition detector
- [ ] Schema is pruned, not pasted whole
- [ ] Every table and FK involved has `notes` / `purpose` in `schema.yaml`
- [ ] Self-referential joins are documented in `purpose`
- [ ] Numeric sanity gate runs before any LLM validation
- [ ] Abstention ("I don't have that information") is reachable
- [ ] The executed SQL, row count, and gate verdicts are attached to the answer
- [ ] The whole run is replayable from stored state
