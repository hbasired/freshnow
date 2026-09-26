# SPEC-000 — System Overview

**Status:** draft · **Phase:** all · **Owner:** engineering
**Depends on:** company answers Block A (see `04-QUESTIONS-FOR-COMPANY.md`)

Requirements are identified as `SPEC-000-Rn` and referenced by tests and task documents.
A requirement that cannot have a failing test written for it is a bad requirement and
must be rewritten.

---

## 1. Purpose

R1. The system collects daily task status from FreshNow employees, detects and routes
blockers, escalates on SLA breach, and gives the CEO an auditable view of operations.

R2. The system is the operational record. No operational fact exists only in a chat log.

R3. The system does not score, rank, or profile individual employees. It measures
process, not people.

---

## 2. Actors

| Actor | Role |
|---|---|
| Employee | Receives tasks, reports status, raises blockers |
| Manager | Creates employee records, assigns work, resolves blockers in their department |
| Resolver | An employee designated to fix a blocker category (may also be a manager) |
| CEO | Sees everything; messages anyone; approves outbound messages sent under his name |
| System | Schedules prompts, parses text, routes, escalates, summarises |

---

## 3. Cross-cutting requirements

### Determinism
R4. Blocker routing MUST be a deterministic lookup on `(category, site, shift)`.
R5. Escalation MUST be a deterministic rule on `severity`, age, and `sla_due_at`.
R6. Given identical inputs and identical reference data, R4 and R5 MUST produce
identical outputs. No model call participates in either.

### Replayability
R7. Every run MUST be reconstructible from stored state: raw input, parsed output,
rules applied, decisions taken, messages emitted.
R8. A stored run MUST be re-executable and produce the same decision, except where
reference data has legitimately changed.

### Auditability
R9. Every state change MUST write an `audit_log` row carrying a `correlation_id`
shared by all steps of that run.
R10. `audit_log` MUST be append-only; the application role has no UPDATE or DELETE.
R11. Any number displayed to the CEO MUST be traceable to the query that produced it.

### Observability
R12. Every scheduled job MUST record a `job_run` row with outcome and duration.
R13. Every LLM call MUST record a `llm_call` row with model, tokens, cost, latency,
and success.
R14. A stuck or looping process MUST be visible in stored traces, not inferable only
from a hanging request.

### Bounded execution
R15. Every tool-calling loop MUST have a hard iteration cap and MUST return a
"could not complete" result on reaching it — never a fabricated answer, never another
loop.
R16. Query results returned to a model MUST be capped (`MAX_ROWS = 50`) and truncation
MUST be disclosed in the answer.
R17. Every retry policy MUST have a finite attempt limit.
R18. Repeated identical tool calls MUST break the loop immediately.

### LLM boundaries
R19. The model MUST NOT produce a number it did not read from a query result.
R20. The model MUST NOT decide who resolves a blocker or whether to escalate.
R21. No message MUST be sent on the CEO's behalf without an explicit human approval
action, recorded.
R22. Abstention ("I don't have that information") MUST be reachable and MUST be
preferred over an improvised answer.

### Failure behaviour
R23. Loss of the LLM provider MUST NOT lose an employee's update. Raw text is persisted
before any model call.
R24. Loss of Telegram MUST NOT lose a queued notification. The outbox retries.
R25. On any ambiguity or gate failure, the system escalates to re-derivation or to a
human — it does not guess.

---

## 4. Non-functional targets

| Attribute | Target | Method |
|---|---|---|
| Webhook acknowledgement | < 1 s | Persist and queue; slow work happens in a job |
| Employee-visible response | Immediate confirmation | Acknowledge before parsing |
| Blocker → resolver notification | < 2 min for high/critical | Outbox worker polls every 10 s |
| Digest delivery | Within 5 min of scheduled time | `job_run` alerting on miss |
| Data loss tolerance | Zero for submitted updates | Write-first ordering, outbox |
| Notification duplication | Zero | `idempotency_key` UNIQUE |
| LLM spend | Under a configured daily cap | Budget check before every call |

---

## 5. Explicit non-goals

R26. The system does NOT perform sentiment analysis on employees.
R27. The system does NOT produce productivity scores or rankings.
R28. The system does NOT track location outside an explicitly notified route feature.
R29. The system does NOT store HR-sensitive categories (salary, discipline, medical,
visa status).
R30. The system does NOT act autonomously on the CEO's behalf.

R26–R30 are permanent design boundaries, not Phase 1 limitations. A request to add any
of them must be escalated, not implemented.

---

## 6. Phase boundaries

| Phase | In scope |
|---|---|
| 1 | Onboarding, daily capture, blockers, rules-based escalation, CEO alerts, basic dashboard, audit and replay spine |
| 2 | In-platform task assignment, notifications, Mini App forms, bounded NL query over curated views |
| 3 | Warehouse: batch/lot traceability, QC and R&D logging, inventory; CEO assistant with read-only tools |
| 4 | Vending telemetry (vendor API preferred), demand forecasting, driver PWA |
| 5 | Route optimization, delivery operations, customer channel |

R31. Building ahead of the current phase is a spec violation. Phase 1 success is
employee response rate above 70% sustained for four weeks, not feature count.
