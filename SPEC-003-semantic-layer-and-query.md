# SPEC-003 — Semantic Layer, Query & Validation

**Status:** draft · **Phase:** 2–3 · **Depends on:** SPEC-000, SPEC-001

Governs any feature where a model produces or reports data.

---

## 1. The translation boundary

R1. The model MUST translate a question into a query. It MUST NOT compute, count,
aggregate, rank, or total.
R2. Aggregation MUST be pushed into SQL. The model receives an answer, not a table.
R3. The model MUST NOT state a number that does not appear in a query result it
received.

---

## 2. Query surface

R4. The model MUST reach data only through defined tools: `list_tables`,
`describe_table`, `sample_rows`, `count_rows`, `run_sql`.
R5. `run_sql` MUST execute on a read-only connection so writes fail at the engine.
R6. In Phase 2, `run_sql` MUST target curated views only, never base tables.
R7. Results MUST be capped at `MAX_ROWS = 50`, and truncation MUST be stated in the
answer.
R8. Every query MUST have a row limit; a query without a `WHERE` or `LIMIT` MUST be
rejected.

---

## 3. Schema context

R9. The full schema MUST NOT be placed in a prompt. Context is pruned to the tables an
intent requires plus their one-hop foreign-key neighbours.
R10. Pruned context MUST include `notes` and `purpose` fields from the semantic layer.
R11. `describe_table` MUST remain available so unpruned tables stay reachable on demand.

---

## 4. Bounded loops

R12. The query tool loop MUST cap at 8 iterations; retrieval at 6.
R13. On reaching a cap, the system MUST return a "could not complete" result with any
partial findings. It MUST NOT loop again and MUST NOT fabricate.
R14. Two consecutive identical tool calls MUST break the loop immediately.
R15. A per-task token budget MUST apply in addition to the iteration cap.

---

## 5. Deterministic gates — run before any LLM validation

R16. **Numeric sanity gate:** if the draft answer states numbers and a result set
exists, at least one stated number MUST literally appear in the returned rows.
R17. **Grounding gate:** a claim about a policy, SLA, or food-safety requirement MUST
cite the source record.
R18. Gates MUST be pure code — no model call.
R19. A failed gate MUST escalate to re-derivation, not fail the request.

---

## 6. Escalating validation

R20. A critic MUST assess the draft and emit a verdict and confidence.
R21. Where confidence is low or a gate failed, a cross-validator MUST re-derive the
answer by a **different method** — not a re-read of the same evidence.
R22. Where critic and cross-validator conflict materially, an arbiter MUST produce a
binding third derivation.
R23. Compute MUST be spent in proportion to doubt. A confident, gate-passing answer
MUST take the cheap path.

---

## 7. Completeness

R24. A completeness check MUST assess recall separately from correctness: whether a
relevant known fact was omitted.
R25. The fact set considered MUST be bounded (cap ~20) to keep the prompt bounded.

---

## 8. Ambiguity

R26. Clarification MUST ask one question at a time, addressing the highest-severity
ambiguity, capped at 3 rounds.
R27. After the cap, the system MUST proceed with a best interpretation flagged
low-confidence.
R28. Complex queries (a join, an aggregation, a top-N, two or more filters, or a time
range) MUST be read back for confirmation before execution.

---

## 9. Abstention and scope

R29. The semantic layer MUST be consulted for scope before execution.
R30. Where the data does not exist, the system MUST say so. It MUST NOT improvise.
R31. "I don't have that information" MUST be a reachable outcome in every query path.

---

## 10. Evidence

R32. Every answer MUST carry: the executed SQL, the row count, gate verdicts, the
confidence, and a `correlation_id`.
R33. The executed SQL MUST be viewable by the CEO alongside the answer.
