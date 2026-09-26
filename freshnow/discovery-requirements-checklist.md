# Discovery Checklist: Vending Telemetry AI + COO Agent Project

This is a working checklist for your intake/discovery conversations with the company — organized as (1) what to request for Part 1 (vending AI), (2) what to request for Part 2 (COO agent), and (3) how to pin down the business KPIs you'll be building and measured against.

---

## Part 1 — Vending Telemetry AI: What to Request

### Fleet & hardware inventory
- Total machine count, manufacturers/models, and age of fleet
- Machine types: snack, cold drink/refrigerated (needs temp sensors), combo — this determines which telemetry signals are even possible
- Is any telemetry already installed? Which vendor (Cantaloupe, Nayax, Parlevel, Vendekin, other)? If so, request API/export access rather than re-instrumenting
- Do the machines natively support DEX (EVA-DTS) and MDB, or are they legacy units needing a bridge/retrofit device?
- Connectivity at each site: cellular coverage, WiFi availability, or none (determines whether you need BLE-relay-on-driver-visit as a fallback)

### Historical data (the single most important ask — get this early, it gates everything)
- Transaction-level sales history, ideally per machine → per slot → per product → timestamp. Ask how far back it goes and in what format (CSV export, DB dump, API)
- Product catalog: SKUs, prices, shelf life/expiry, category
- Historical service/maintenance logs — breakdown events, repair tickets, technician notes (needed to train/validate anomaly detection)
- Historical route and driver schedules — current planning method (manual, spreadsheet, or existing routing software)
- Cash, coin, and cashless payment processor data/reconciliation records
- Machine location metadata: address, geo-coordinates, site type (office, school, hospital, transit) — this becomes a forecasting feature
- Any existing weather or local-event data already used informally by planners

### Current process documentation
- How replenishment decisions are made today (fixed schedule? gut-feel? min-max thresholds?)
- How routes are planned and by whom
- Existing SLAs with site owners/customers (e.g., "restocked within 48 hours of low-stock alert")
- Current escalation path when a machine goes down or a driver reports an issue

### IT & infrastructure
- Preferred/existing cloud provider (AWS/Azure/GCP) and any mandated stack
- Data residency and security requirements
- Credentials/API access to any existing vending-management platform
- Scope for a pilot — how many machines/which region they're willing to instrument first (this should map to the "Stage 0" shadow-mode phase before any live dispatch)

---

## Part 2 — COO Agent: What to Request

### Process inventory (the equivalent of "historical data" for this part)
- An actual list of the company's existing cron jobs / scheduled automations — what they do, how often, what breaks when they fail. This is explicitly called out in your source docs as the right starting substrate (migrate to durable execution before adding any AI)
- A list of recurring manual operations across departments that are automation candidates — ranked by how well-defined and low-stakes they are
- Org chart and who owns each operational domain (finance, HR, legal, ops) — you'll need a governance owner per domain, not just one company-wide sponsor

### Systems & integration
- Inventory of internal systems and whether they expose APIs: ERP, CRM, HRIS, finance/accounting, ticketing/helpdesk
- Existing identity provider / SSO (for agent identity — SPIFFE/Entra Agent ID-style patterns need this)
- Data classification policy — what's confidential (financial, HR, legal) vs. general, since this determines the information-flow controls (Bell-LaPadula/Biba-style labeling) the architecture calls for

### Governance & risk appetite
- Existing compliance obligations (SOC 2, ISO, industry-specific regs, EU AI Act exposure if operating in the EU)
- Who has authority to approve an agent taking an irreversible action, and what the approval SLA should be
- Any prior AI/automation pilots and what happened — successes and failures are both useful signal
- Risk tolerance for the "never fully autonomous" domains (finance, HR, legal) — get this in writing early, since it's a hard boundary in the recommended architecture, not a nice-to-have

### Technical
- Current data warehouse/BI tooling
- Whether they're on Kubernetes already (changes whether Kagenti-style deployment is realistic vs. a simpler VM-based rollout)

---

## Part 3 — Finding the Business KPIs

You need two categories of KPI here: **baseline/current-state metrics** (what the company already tracks, so you know what "better" means) and **system-performance metrics** (the new things you'll report on once the AI/agent is live). Don't invent these — pull them from stakeholders and existing reporting.

### How to gather them
- Interview the actual operators, not just the sponsor: route drivers/dispatchers, ops managers, and whoever currently owns the P&L for the vending business or the automated processes
- Ask for any existing weekly/monthly ops report, dashboard, or board deck — these usually already contain the KPIs leadership cares about, you just need to see them
- Ask finance for the cost baseline: cost per service visit, cost per stockout, labor/fuel cost per route, machine revenue by location
- Ask "what does success look like in 6 months / 12 months" directly — the answer is usually the KPI in disguise

### Candidate KPIs for Part 1 (vending ops) — cross-referenced from your docs' own success gates
- **Stockout rate** (per machine, per slot) — the core inventory metric
- **Service visits per week / route miles driven** — the routing-efficiency metric
- **Forecast accuracy** vs. the current static schedule — needed to know if the ML is even beating the status quo
- **False-positive alert rate**, tracked via driver acknowledged-vs-dismissed ratio — a trust metric, not just an accuracy metric
- **Machine uptime / MTTR (mean time to repair) / MTBF (mean time between failures)** — the predictive-maintenance metric
- **Revenue per machine** and **cash-collection efficiency**

### Candidate KPIs for Part 2 (COO agent)
- **Containment rate** — % of tasks the agent resolves without human escalation (IBM's AskHR benchmark of 94% is the reference point, but expect much lower early on)
- **Cost per resolved task** vs. the pre-automation baseline
- **Policy-bypass incidents in red-team testing** — a governance KPI, should be zero before expanding scope
- **Cycle time reduction** for whatever process is automated
- **Realized $ P&L impact vs. invested cost** — this is the metric that matters most to leadership, and per the MIT NANDA report your docs cite, it's also the one 95% of enterprise GenAI pilots fail to move. Get a baseline number here before you build anything, or you won't be able to prove impact later.

### A framework to keep the KPI conversation focused
- Push for one **north-star metric** per part (e.g., "reduction in stockout-driven lost sales" for Part 1; "hours of manual ops work removed per month" for Part 2)
- Separate **leading indicators** (forecast accuracy, alert trust, agent containment rate) from **lagging indicators** (revenue, cost, P&L) — you'll move the leading ones first and use them to predict the lagging ones
- Explicitly capture the **decision gates already implied by the architecture docs** as KPIs, since they're the thresholds that determine whether you proceed to the next stage: e.g., ">90% of machines reporting telemetry reliably," "≥15–25% reduction in service visits or stockouts," "zero policy-bypass incidents"

---

## One practical note
Get the historical data and the cron-job/process inventory requests in first, before anything else — both timelines depend entirely on data quality and availability, and it's common for companies to discover mid-project that the historical data they thought they had is incomplete or in an unusable format.
