# Reference Systems & Benchmarks

Production systems worth studying before building each part of FreshNow. The point is
not to copy them but to avoid re-deriving solutions that already exist, and to know
what "good" looks like for each mechanism.

> **Accuracy note.** Everything below should be re-verified before you rely on it.
> Product capabilities, pricing, and availability change; several figures here are
> vendor-reported and are marked as such. Claude Code should **web-search the current
> state of the relevant systems at the start of each task** rather than trusting this
> file, which is a starting point and will go stale.

---

## 1. Chat-based status collection — the closest analogues to Phase 1

These do almost exactly what Phase 1 does, on Slack and Teams rather than Telegram.
Study their **workflow design**, not their code.

| System | What to learn from it |
|---|---|
| **Geekbot** | The canonical async standup bot. Scheduled prompts at a per-user time, a fixed small question set, compiled summaries. Its whole design argues for *few questions, consistent timing*. |
| **DailyBot** | Similar, with more workflow branching and integrations. Worth looking at how it handles follow-ups and reminders. |
| **Standuply** | Adds surveys and reporting on top of standups. Useful for seeing what reporting people actually ask for after six months. |
| **Range** | Check-ins tied to goals rather than tasks. Different framing of the same problem. |
| **Jell / Status Hero** | Older entrants; useful mainly for the shape of their summary views. |

**The most valuable thing to research about this category is its documented failure
mode**, not its features. Search for critiques of async standup bots and you find the
same complaint repeatedly: after a few weeks people reduce to one-word answers and
managers stop reading the digests. That is the risk FreshNow's Phase 1 is actually
fighting, and it is a workflow problem, not a technical one.

**Design conclusions to carry over:** two or three questions maximum; buttons for the
structured fields and free text only for the exception; one reminder, never two;
timing that follows the individual's shift.

---

## 2. Escalation and on-call — the model for the blocker engine

| System | What to learn from it |
|---|---|
| **PagerDuty** | The reference implementation of escalation policies: levels, timeouts, acknowledge/resolve semantics, and what happens when nobody responds. FreshNow's blocker escalation is a simplified version of this exact model. |
| **Opsgenie** (Atlassian) | Similar model; useful for its on-call rotation and routing-rule design. |
| **Grafana OnCall** | Open source, so you can read how escalation chains and acknowledgement are actually implemented rather than inferring from docs. |

**Concepts to adopt directly:** acknowledge as a distinct state from resolve; escalation
levels with per-level timeouts; a routing key that maps an incident type to a
responder; suppression and deduplication so a repeating condition doesn't page five
times.

**Alert fatigue** is the thing to research hardest here. Every mature incident system
has learned the same lesson — the failure is not too few alerts, it is too many, and
once responders start dismissing alerts the system is worse than nothing. FreshNow's
equivalent is the CEO ignoring blocker notifications, which would end the project's
usefulness quietly.

---

## 3. Text-to-SQL and semantic layers — the model for the query feature

This is where the most careful research is warranted, because the failure mode is
silent.

| System | What to learn from it |
|---|---|
| **dbt Semantic Layer / MetricFlow** | The mature answer to "the model doesn't know what your columns mean." Metrics are defined once, centrally, and queried by name rather than reconstructed from raw tables each time. FreshNow's `schema.yaml` is a small hand-rolled version of this idea. |
| **Cube** | Semantic layer with a query API. Worth studying for how it exposes a bounded, pre-approved surface rather than the raw schema. |
| **Looker / LookML** | The original commercial semantic layer. The concept of an "explore" — a curated, joinable subset — is directly applicable to the curated-views approach. |
| **Vanna.ai, Dataherald** | Open-source text-to-SQL projects. Useful for seeing which guardrails they found necessary in practice. |
| **Spider / BIRD benchmarks** | Academic text-to-SQL benchmarks. Useful context, but note the widely-discussed gap between benchmark accuracy and real-schema performance — worth searching for current commentary on that gap before designing the query feature. |

**The critical thing to internalise:** text-to-SQL fails by returning a query that
executes successfully and produces a plausible wrong number. It does not error. Every
guardrail in the `deterministic-query` skill exists because of this property.

---

## 4. Reliable messaging and job orchestration

| System / pattern | What to learn from it |
|---|---|
| **Transactional outbox pattern** | Well-documented in the microservices literature (Chris Richardson's microservices.io is a good primary reference). This is exactly what `notification_outbox` implements and why. |
| **BullMQ** | Read the docs on delayed jobs, repeatable jobs, and job IDs for deduplication. The delayed-job primitive is what makes SLA timers work. |
| **Temporal** | Not being used in Phase 1, but worth understanding the durable-execution model so you know what you're trading away and when to revisit. Their own material positions Schedules as a cron replacement. |
| **Inngest / Trigger.dev / Hatchet** | Modern managed alternatives. Useful comparison points for the Phase 4 decision. |

---

## 5. Agentic pipelines with validation — the model for Phase 2–3

| System | What to learn from it |
|---|---|
| **LangGraph** | The state-machine model for multi-step LLM workflows: typed state, conditional edges, checkpointers for durability, `interrupt()` for human-in-the-loop that survives across requests. Even if Phase 1 doesn't use it, the *pattern* of "one typed state object flowing through a graph" is the right mental model. |
| **The TechNova teardown** (supplied with this project) | A worked example of the full pattern: router → intent → clarification → read-back → bounded execution → deterministic gates → critic → cross-validator → arbiter → completeness → finaliser. Its measurements are specific to its own corpus and should not be treated as targets. |
| **IBM watsonx Orchestrate** | Vendor-reported: their internal AskHR handled 11.5M+ interactions in 2024 at 94% containment. Treat the number as directional. The useful part is their published guidance — start with single specialist agents, compose later, make orchestration observable, log every decision and tool call. |
| **Anthropic, "Building Effective Agents"** | The workflows-vs-agents distinction and the five workflow patterns. Its central recommendation — find the simplest solution, which may mean not building an agentic system at all — is the reason Phase 1 has no agent. |
| **HumanLayer "12-factor agents"** | Practical production principles: own your prompts and context, small focused agents, explicit human-in-the-loop, resumable state. |

---

## 6. Vending telemetry — Phase 4, buy rather than build

| System | Relevance |
|---|---|
| **Nayax** | Payments plus telemetry (their AMIT hardware line), with reported activity in the UAE market. If they have an API, integrating is dramatically cheaper than building DEX/MDB ingestion. **Verify current UAE availability and API access directly with them.** |
| **Cantaloupe (Seed)** | Long-established US vending management platform. Their BLE "Seed Key" approach — capturing DEX via a driver's phone where there's no cellular coverage — is a genuinely useful pattern if FreshNow has machines in poor-signal locations. |
| **Parlevel** | Telemetry plus dynamic routing and pre-kitting (picking exact quantities per machine before the driver leaves). The pre-kitting concept is directly applicable. |
| **Vendekin** | Reported EMEA/Middle East presence. Worth a direct enquiry alongside Nayax. |

**Standards to understand before any conversation with these vendors:** DEX / EVA-DTS
(the aggregated snapshot format) and MDB (the internal bus carrying live transaction
data). Knowing which of FreshNow's machines support which determines whether retrofit
telemetry is even possible.

---

## 7. Route optimization — Phase 5

| System | Relevance |
|---|---|
| **Google OR-Tools** | The standard open-source VRP solver. Free, self-hosted, well-documented, with worked vehicle-routing examples. This is almost certainly the right choice at FreshNow's fleet size. |
| **VROOM** | Lighter-weight open-source routing engine, often paired with OSRM for real road distances. Faster to stand up than OR-Tools for straightforward cases. |
| **OptimoRoute / Routific / Onfleet** | Commercial. Worth pricing only if integration time turns out to be the bottleneck rather than solver capability. |

The relevant problem class is the **Inventory Routing Problem** — deciding not just the
route but which machines to visit and how much to load, subject to turnover deadlines
and vehicle capacity. Search for IRP literature rather than plain VRP when designing
this.

---

## 8. Perishable inventory and demand forecasting — Phase 4

Fresh juice is not a snack machine, and this changes the problem materially. Short
shelf life means over-stocking causes **spoilage**, not just holding cost.

- **The newsvendor problem** is the correct textbook framing: a single-period stocking
  decision balancing the cost of running out against the cost of unsold perishable
  stock. Search for newsvendor / perishable inventory management.
- **Start with statistical baselines**, not ML. Seasonal naive, exponential smoothing,
  and per-machine per-slot averages will beat a poorly-fed model and give you a
  baseline to prove improvement against.
- **Track waste from day one.** Without a spoilage baseline you cannot demonstrate that
  forecasting improved anything.

---

## 9. Food safety and traceability — Phase 3

- **Dubai Municipality food-safety requirements** — HACCP-based food safety management
  system under the Dubai Food Code, cold-chain temperature requirements, a certified
  Person-in-Charge, and registration on the **DMChecked** platform (which replaced
  FoodWatch Connect). **Verify current requirements directly with the Municipality**;
  this area changed recently and secondhand summaries go stale fast.
- **Two-way traceability** is the core requirement: from a customer complaint back to a
  batch and its inputs, and from a suspect input lot forward to every unit that used
  it. Design the schema for this from the start — retrofitting it is painful.
- Worth studying: how food ERP systems (even at small scale) model lot/batch genealogy.

---

## 10. Observability and audit

| System | Relevance |
|---|---|
| **OpenTelemetry** | The vendor-neutral tracing standard. Note that its GenAI semantic conventions were still marked experimental as of the reference material — verify current status before depending on them. |
| **Langfuse** | Open source LLM observability — traces, costs, evaluations. A reasonable self-hosted choice if the built-in `run_trace` table proves insufficient. |
| **LangSmith** | Proprietary equivalent, free developer tier. Better if the project ends up LangChain-centric. |
| **Uptime Kuma** | Self-hosted uptime monitoring. Free, tiny footprint, appropriate for one VPS. |

The requirement to satisfy is stricter than typical app observability: **every number
shown to the CEO must trace back to the query that produced it.** That is an audit
requirement, not a debugging convenience, and it is why the trace is stored in Postgres
alongside the data rather than only shipped to an external tool.

---

## How to use this file in the build

At the start of each task, `spec-driven-build` requires a web search. This file tells
you **what to search for**. The pattern:

1. Identify which section above covers the task.
2. Search for the current state of the two or three most relevant systems.
3. Look specifically for **documented failure modes**, not feature lists — the useful
   knowledge in this category is almost always "here is what broke in production."
4. Record what you found and what you adopted in the task HTML.

If a search turns up something that contradicts this file, **the search wins** — and
update this file in the same task.
