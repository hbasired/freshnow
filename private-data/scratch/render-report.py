"""Render private-data/reports/televend-data-inventory.html from the JSON the probes stored.

Every number in the tiles and tables is read from those files here. The "Things to know" list is the
exception: it restates findings recorded in the knowledge base (gotchas G147–G161), numbers included.
Run:  python -I private-data/scratch/render-report.py
"""
import html
import json
import os
import statistics

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
P = lambda *a: os.path.join(ROOT, *a)


def load(*a):
    with open(P(*a), encoding="utf-8") as f:
        return json.load(f)


snap = load("private-data", "reports", "snapshot-2026-10-14.json")
cash = load("private-data", "reports", "cash-crosscheck-2026-10-14.json")
v12 = load("private-data", "televend-verify", "2026-10-12.json")
v05 = load("private-data", "televend-verify", "2026-10-05.json")
acl = load("private-data", "televend-probe", "2026-10-12", "acl.json")["content"]

e = html.escape
fmt = lambda n: f"{n:,}" if isinstance(n, (int, float)) else e(str(n))


def bars(rows, unit="", max_rows=10):
    """Horizontal bars, one hue; value printed at the end (doubles as the table view)."""
    rows = rows[:max_rows]
    top = max((v for _, v in rows), default=1) or 1
    out = ['<div class="bars" role="table">']
    for label, v in rows:
        pct = max(2.0, 100.0 * v / top)
        out.append(
            f'<div class="bar-row" role="row" title="{e(str(label))}: {fmt(v)}{e(unit)}">'
            f'<span class="bar-label" role="cell">{e(str(label))}</span>'
            f'<span class="bar-track"><span class="bar" style="width:{pct:.1f}%"></span></span>'
            f'<span class="bar-value" role="cell">{fmt(v)}{e(unit)}</span></div>'
        )
    out.append("</div>")
    return "\n".join(out)


def tile(value, label, note="", status=None):
    icon = {"good": "✓", "warn": "!", "bad": "✕"}.get(status, "")
    badge = f'<span class="status {status}">{icon}</span>' if status else ""
    return (
        f'<div class="tile">{badge}<div class="tile-value">{value}</div>'
        f'<div class="tile-label">{e(label)}</div>'
        + (f'<div class="tile-note">{e(note)}</div>' if note else "")
        + "</div>"
    )


s = snap["sales"]
alarms = snap["alarms"]
warnings = snap["warnings"]
ref = snap["refills"]
pay = list(s["byPaymentType"].items())
cash_cups = s["byPaymentType"].get("Cash", 0)
cash_share = round(100 * cash_cups / s["cupsSold"]) if s["cupsSold"] else 0

matched = cash["matched"]
apart = [r["minutesApart"] for r in matched]
per_person = {}
for r in matched:
    k = r["who"] or "(no name in post)"
    per_person.setdefault(k, [0, 0])
    per_person[k][0] += 1
    per_person[k][1] += r["amount"] or 0

# Permissions the integration needs, read from the account's own access-control list.
def flag(path):
    cur = acl
    for p in path.split("/"):
        cur = cur.get(p) if isinstance(cur, dict) else None
    return cur

perm_rows = [
    ("Vend list", "reports_permission/vend_list"),
    ("Vend revenue (AED per sale)", "reports_permission/vend_revenue"),
    ("Refill log", "reports_permission/refill_log"),
    ("Event list (alarms)", "event_list_permission/view"),
    ("Cash centre — collection details", "cash_center_permission/cash_center_details_view"),
    ("Cash flow report", "reports_permission/cash_flow"),
    ("Cash details", "reports_permission/cash_details_view"),
    ("Machine inventory report", "reports_permission/machine_inventory"),
    ("Can EDIT machines", "machines_permission_edit"),
    ("Can EDIT products & prices", "product_permission/edit"),
    ("Can EDIT event settings", "event_configuration_permission/edit"),
    ("Can view / create users", "user_permission/user_view"),
]


def yes_no(v, want):
    if v is None:
        return '<span class="pill muted">unknown</span>'
    good = (v is True) == want
    return f'<span class="pill {"ok" if good else "no"}">{"yes" if v else "no"}</span>'


def verify_rows(v):
    m, r, ev, vd = v["machines"], v["refills"], v["events"], v["vends"]
    return [
        ("Machines (total / enabled)", f'{m["live"]["total"]} / {m["live"]["enabled"]}', f'{m["file"]["total"]} / {m["file"]["enabled"]}',
         f'same — {len(m["enabledOnlyLive"])} renamed since the export'),
        ("Refills (rows / cups)", f'{r["live"]["rows"]} / {fmt(r["live"]["cups"])}', f'{r["file"]["rows"]} / {fmt(r["file"]["cups"])}',
         f'{len(r["assetMismatches"])} mismatches by machine number'),
        ("Alarms & warnings in your export", f'{ev["fileRowsMatchedToLive"]} matched', f'{ev["file"]["rows"]} rows',
         "every row found in Televend" if ev["fileRowsMatchedToLive"] == ev["file"]["rows"] else "some rows not found"),
        ("Vends (rows / Televend count)", fmt(vd["listRows"]), fmt(vd["aggregate"]["vends"]), "equal" if vd["listRows"] == vd["aggregate"]["vends"] else "differ"),
    ]


ver_html = []
for label, v in (("12 Oct 2026", v12), ("5 Oct 2026", v05)):
    ver_html.append(f'<h3>{e(label)}</h3><div class="tw"><table><tr><th>What</th><th>Televend now</th><th>Your export</th><th>Result</th></tr>')
    for row in verify_rows(v):
        ver_html.append("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>")
    ver_html.append("</table></div>")

drafts = {
    "1 · To Televend IT — read-only API access": """Subject: Daily Vending LLC (company 3334) — read-only API access request

Hello Televend team,

We would like to connect our internal operations system to Televend Cloud through your documented API
(devportal.televendcloud.com). Could you please onboard us with:

1. An OAuth2 client (client_id / client_secret) limited to READ scopes, for:
   - Data Streaming: vends, vending-events, fill-events, cash-collections, cashbag-countings,
     machine-inventories, planograms, component-consumption-aggregates
   - Master Data: GET importer endpoints (machines, locations, regions, products, components, recipes)
   - Operational: GET product, order and ticket endpoints
2. The production Keycloak host/realm and API base URL (the portal documents UAT only), and UAT access first.
3. A one-off historical export of vends, events, fill events and cash collections from 1 January 2026,
   since the streams keep 7 days.
4. The cost of API access under our subscription, any rate limits for our integration, and whether
   your terms allow us to read our data this way.

Our system will never write to Televend; the only call that is not a read will be the stream offset commit.

Thank you,
<name>, Daily Vending LLC""",
    "2 · To FreshNow's Televend administrator — a view-only user": """Please create a dedicated Televend Cloud user for the FreshNow operations system:

- Name: FreshNow Integration (read-only)
- Company: Daily Vending LLC (3334), all machines
- VIEW only — no edit rights anywhere:
  vend list, vend revenue, refill log, event list, machines, machine stock,
  cash centre details (view), cash flow report, cash conformity, machine inventory report
- No user, product, price, planogram, route or event-configuration EDIT rights.

Send the login to <name> privately (not by WhatsApp). The account currently used is a
CompanyManager with edit rights and cannot see cash amounts.""",
    "3 · To the bank / cash-in-transit company behind the deposit machine": """Subject: Daily Vending LLC — deposit statements for our Cash Deposit Machine bags

Hello,

Our drivers deposit cash in the Obolus+ cash deposit system (receipts show Operator, CDS Id, Bag number
and Transaction number). For daily reconciliation we would like:

1. Online portal access to our deposit history, and
2. A daily statement export (MT940 or CSV) listing each deposit with date/time, operator, CDS Id,
   bag number, transaction number, denominations and total.

Please let us know what is available and any cost.

<name>, Daily Vending LLC""",
    "4 · To Oranfresh — parts catalogue": """Subject: Spare parts catalogue for our Oranfresh vending machines

Hello Oranfresh customer service,

We operate Oranfresh fresh-orange-juice vending machines in the UAE. Please send the spare-parts
catalogue (part numbers and descriptions) for the squeezing unit, knives/blades, peeler, filters,
cup dispenser and cleaning system, and the recommended replacement intervals, so we can track parts
per machine. If possible, include the cups-per-load and oranges-per-cup figures for 340 ml cups.

<name>, Daily Vending LLC""",
}

unmatched_posts = cash["whatsappPostsWithoutTelevendEvent"]
unreported = cash["televendCollectionsWithoutWhatsappPost"]

page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Televend Data Inventory</title>
<style>
:root{{color-scheme:light;--bg:#f6f6f3;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#8a897f;--line:#e2e1db;
  --bar:#2a78d6;--track:#ecebe6;--good:#0ca30c;--warn:#fab219;--bad:#d03b3b;--accent:#97d700}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{color-scheme:dark;--bg:#121211;--surface:#1a1a19;--ink:#f0efec;
  --ink-2:#c3c2b7;--muted:#8f8e85;--line:#33332f;--bar:#3987e5;--track:#2a2a27}}}}
:root[data-theme="dark"]{{color-scheme:dark;--bg:#121211;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--muted:#8f8e85;--line:#33332f;--bar:#3987e5;--track:#2a2a27}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}}
main{{max-width:1080px;margin:0 auto;padding:32px 20px 64px}}
h1{{font-size:1.85rem;margin:0}} h2{{font-size:1.3rem;margin:2.4rem 0 .4rem}} h3{{font-size:1.02rem;margin:1.4rem 0 .4rem;color:var(--ink-2)}}
.sub{{color:var(--ink-2);margin:.3rem 0 0}} .private{{display:inline-block;margin-top:.7rem;padding:4px 10px;border-radius:999px;background:#d03b3b1a;color:var(--bad);font-size:.85rem;font-weight:600}}
.lead{{color:var(--ink-2);max-width:820px}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:14px 0}}
.tile{{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px}}
.tile-value{{font-size:2rem;font-weight:700;line-height:1.1}} .tile-label{{color:var(--ink-2);margin-top:4px}} .tile-note{{color:var(--muted);font-size:.84rem;margin-top:4px}}
.status{{position:absolute;top:12px;right:12px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:.8rem;color:#fff}}
.status.good{{background:var(--good)}} .status.warn{{background:var(--warn);color:#000}} .status.bad{{background:var(--bad)}}
.grid2{{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}}
.card{{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px}}
.card h3{{margin-top:0}}
.bars{{display:flex;flex-direction:column;gap:6px}}
.bar-row{{display:grid;grid-template-columns:minmax(90px,44%) 1fr auto;gap:10px;align-items:center;font-size:.9rem}}
.bar-label{{color:var(--ink-2);line-height:1.25;overflow-wrap:anywhere}}
.bar-track{{height:14px;background:var(--track);border-radius:4px;overflow:hidden}}
.bar{{display:block;height:100%;background:var(--bar);border-radius:0 4px 4px 0}}
.bar-row:hover .bar{{filter:brightness(1.15)}} .bar-value{{font-variant-numeric:tabular-nums;min-width:3ch;text-align:right}}
.tw{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;font-size:.9rem;background:var(--surface)}}
th,td{{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}} th{{color:var(--ink-2);font-weight:600}}
.pill{{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.8rem;font-weight:600}}
.pill.ok{{background:#0ca30c22;color:var(--good)}} .pill.no{{background:#d03b3b22;color:var(--bad)}} .pill.muted{{background:var(--track);color:var(--muted)}}
pre{{white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;font-size:.85rem}}
code{{background:var(--track);padding:1px 6px;border-radius:4px}}
.note{{color:var(--muted);font-size:.85rem}}
details{{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:10px 0}}
summary{{cursor:pointer;font-weight:600}}
ul{{padding-left:1.2rem}} li{{margin:4px 0}}
@media (max-width:600px){{main{{padding:22px 16px 48px}} .tile-value{{font-size:1.6rem}}}}
</style></head><body><main>
<h1>Televend — what we can see now</h1>
<p class="sub">Daily Vending LLC (Televend company 3334) · read on 15 Oct 2026 through the read-only connector (TASK-055/056)</p>
<span class="private">Private — contains staff names. Management only; do not forward.</span>

<div class="tiles">
{tile("Works", "Reading Televend", "sign-in + read requests only", "good")}
{tile("Blocked", "Changing Televend", "every write is refused before it is sent", "good")}
{tile("2 days", "Checked against your exports", "machines, refills, alarms, vends — all matched", "good")}
{tile("Hidden", "Cash amounts in Televend", "this account lacks cash-centre & revenue view", "warn")}
</div>

<h2>14 October at a glance</h2>
<p class="lead">From Televend's own records for the business day 14 Oct 2026 (Asia/Dubai). Totals are counted by the system, not estimated.</p>
<div class="tiles">
{tile(fmt(s["cupsSold"]), "Cups sold", f'equals Televend’s own count ({fmt(s["televendOwnCount"])})')}
{tile(f'{s["machinesWithSales"]} / {v12["machines"]["live"]["enabled"]}', "Machines that sold", "enabled machines in Televend")}
{tile(f'{cash_share}%', "Paid in cash", f'{fmt(cash_cups)} cups — the rest cashless/token/wallet')}
{tile(str(alarms["selected"]), "Alarms", f'{alarms["unresolved"]} still open at the end of the day', "warn" if alarms["unresolved"] else "good")}
{tile(str(snap["cash"]["collections"]), "Cash collections", "machines whose cash box was emptied")}
{tile(str(ref["rows"]), "Refill log rows", f'{ref["byAction"].get("filled", 0)} fills, {ref["byAction"].get("corrected", 0)} corrections · {fmt(ref["cupsFilled"])} cups')}
</div>
<div class="grid2">
<div class="card"><h3>How customers paid (cups)</h3>{bars(pay)}</div>
<div class="card"><h3>Busiest machines (cups) — by machine number</h3>{bars([(f'#{m["asset"]}' if m["asset"] else m["name"], m["cups"]) for m in s["topMachinesByCups"]], max_rows=8)}</div>
<div class="card"><h3>Alarms by reason</h3>{bars([(x["what"], x["count"]) for x in alarms["topReasons"]])}
<p class="note">Most of these are short blips (communication, card reader) that clear by themselves within minutes; “No cash sales” and “Bill / Cash Box Full” are the ones that need a person.</p></div>
<div class="card"><h3>Cups filled, by person (initials)</h3>{bars(list(ref["cupsFilledByPerson"].items()))}
<p class="note">From Televend’s refill log (who entered the fill in the Staff App). A record of work done — not a score.</p></div>
</div>
<p class="note">Warnings that day: {", ".join(f'{e(x["what"])} ×{x["count"]}' for x in warnings["topReasons"])}.</p>

<h2>Cash: was every collection reported?</h2>
<p class="lead">Televend logs a machine event — <i>“Cash has been collected from the machine.”</i> — every time a cash box is emptied.
We matched it against the photos posted in the WhatsApp group <b>CASH COLLECTION DAILY VENDING</b> for the night shift
of 14 Oct (12:00 on the 14th to 11:00 on the 15th), by machine number, within 90 minutes.</p>
<div class="tiles">
{tile(f'{len(matched)} of {cash["whatsappCashPosts"]}', "WhatsApp posts matched to Televend", "same machine number", "good")}
{tile(f'{statistics.median(apart):g} min', "Typical delay", f'Televend event → WhatsApp post (max {max(apart)} min)')}
{tile(str(len(unreported)), "Collections without a post", "in the exported chat", "warn" if unreported else "good")}
</div>
<div class="grid2">
<div class="card"><h3>Posts with no matching Televend collection</h3><ul>
{"".join(f'<li><b>{e(p["text"])}</b> ({e(p["at"])}) — ' + ('the machine number is wrong: Televend shows the collection at <b>Naif Souk-319</b> 8 minutes earlier; 318 is Sharjah Central.' if p["asset"] == 318 else 'not a machine collection (a receipt photo).') + '</li>' for p in unmatched_posts)}
</ul></div>
<div class="card"><h3>Televend collections with no post</h3><ul>
{"".join(f'<li>{e(u["at"])} — {e(u["machine"])}' + (' (the mistyped “318” post above)' if u["asset"] == 319 else (' — after the chat was exported (10:40); its 10:44 photo is in the folder' if u["asset"] == 389 else ' — after the chat was exported (10:40)')) + '</li>' for u in unreported)}
</ul></div>
</div>
<h3>Matched collections per person (amounts as written in their posts)</h3>
<div class="tw"><table><tr><th>Person</th><th>Collections matched</th><th>AED in their posts</th></tr>
{"".join(f'<tr><td>{e(k)}</td><td>{n}</td><td>{fmt(a)}</td></tr>' for k, (n, a) in sorted(per_person.items()))}
</table></div>
<p class="note">These per-person totals agree with the totals the same people posted at the end of the shift (e.g. 1,540 and 1,280 AED).
What cannot be checked yet is whether the amount itself is right: the expected cash per machine needs Televend’s cash-centre view (see below).</p>

<h2>What the system can read from Televend</h2>
<div class="tw"><table><tr><th>Data</th><th>Readable now</th><th>What it gives</th><th>Limit</th></tr>
<tr><td>Machines</td><td><span class="pill ok">yes</span></td><td>name, region, type, enabled, last sale, last refill, stock %, signal</td><td>names change — matched by machine number</td></tr>
<tr><td>Sales (vends)</td><td><span class="pill ok">yes</span></td><td>every cup: time, machine, product, payment type</td><td>price (AED) hidden from this account</td></tr>
<tr><td>Alarms, warnings, info events</td><td><span class="pill ok">yes</span></td><td>what happened, when, when resolved, repeats</td><td>who resolved it is personal data</td></tr>
<tr><td>Cash collections — when</td><td><span class="pill ok">yes</span></td><td>the “cash collected” event per machine</td><td>no amount</td></tr>
<tr><td>Cash collections — how much</td><td><span class="pill no">no</span></td><td>—</td><td>needs cash-centre view (403 today)</td></tr>
<tr><td>Refill log</td><td><span class="pill ok">yes</span></td><td>who filled which machine, when, how many cups; corrections</td><td>one request per machine per day</td></tr>
<tr><td>Warehouse / van stock in Televend</td><td><span class="pill muted">empty</span></td><td>—</td><td>Televend’s inventory module is not used by FreshNow</td></tr>
<tr><td>History</td><td><span class="pill ok">yes</span></td><td>sales back at least to Oct 2025; events to at least Apr 2026</td><td>the official API keeps only 7 days</td></tr>
</table></div>

<h2>What this account may do in Televend</h2>
<p class="lead">Read from the account’s own permission list. It can change a lot — which is why the system, not the account, guarantees read-only —
and it cannot see cash amounts.</p>
<div class="tw"><table><tr><th>Permission</th><th>This account</th><th>The integration user should have</th></tr>
{"".join(f'<tr><td>{e(label)}</td><td>{yes_no(flag(path), not label.startswith(("Can EDIT", "Can view / create")))}</td><td>{"no" if label.startswith(("Can EDIT", "Can view / create")) else "yes (view)"}</td></tr>' for label, path in perm_rows)}
</table></div>

<h2>Checked against your own exports</h2>
<p class="lead">A live read of two past days, compared with the Excel/CSV files downloaded from the Televend portal.</p>
{"".join(ver_html)}

<h2>Things to know about Televend’s data</h2>
<ul>
<li><b>Daily totals:</b> Televend’s sales counter ignores the time of day — asking for 06:00–07:00 returns the whole day. The system only uses it for whole days.</li>
<li><b>Long lists can shift while being read:</b> reading one 23-hour list twice gave 95 duplicates and 95 missing rows. The system reads in small time slices instead — re-reads now match exactly.</li>
<li><b>Machines get renamed:</b> 9 of the 87 enabled machines changed name between 13 and 15 Oct. The machine number (e.g. 543) stays — the system keys on it.</li>
<li><b>A machine that moves keeps its old record:</b> Televend gives a moved machine a new record and switches the old one off. The old record still holds its refills — including the machine being emptied before the move — but no longer shows a “last refill”. Machine 393 moved on 6 Oct; its rows of 4 and 6 Oct were only on the old record. The system now reads every record, switched off or not, for past days.</li>
<li><b>Two refills in the same second can both be real:</b> a two-juice machine logs one per column. The system tells them apart by column (11 Oct: one machine, columns 511 and 767, 3 cups each).</li>
<li><b>Some alarms show “resolved” before they started</b> (repeating alarms). Shown as a note, never as a negative time.</li>
<li><b>Typed WhatsApp posts carry mistakes</b> (“Naif 318” was machine 319). Scanning the machine’s QR code in the new app removes this.</li>
</ul>

<h2>Requests to send</h2>
<p class="lead">Ready-to-send drafts. Replace &lt;name&gt; and send from a company address.</p>
{"".join(f'<details><summary>{e(t)}</summary><pre>{e(body)}</pre></details>' for t, body in drafts.items())}

<h2>How to use it</h2>
<ul>
<li>In Claude Code (this project): the <code>freshnow-televend</code> tools — status, machines, sales on a day, alarms on a day, refills on a day, cash collections on a day.</li>
<li><code>pnpm televend:sync</code> — read what is new (the worker does this every 10 minutes); <code>pnpm televend:backfill --from 2026-09-01 --to 2026-10-14</code> — load history.</li>
<li><code>pnpm televend:verify --day 2026-10-12</code> — compare a day with the exports in <code>data-televend</code>.</li>
</ul>
<p class="note">Source files: snapshot-2026-10-14.json, cash-crosscheck-2026-10-14.json, televend-verify/2026-10-12.json and 2026-10-05.json, televend-probe/acl.json — all under private-data/.</p>
</main></body></html>
"""

out = P("private-data", "reports", "televend-data-inventory.html")
with open(out, "w", encoding="utf-8", newline="\n") as f:
    f.write(page)
print("wrote", out, len(page), "bytes")
