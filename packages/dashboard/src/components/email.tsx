import { useEffect, useState } from "react";
import { api, dmon, hhmm, type EmailOverview, type EmailProposal, type Employee } from "../lib/api";
import { Button, PersonPicker, TextField, Toast, useAction } from "./form";
import { Card, DataTable, Empty, Pill, Spinner } from "./ui";

/**
 * Email (TASK-053). The CEO's page: is email sending, is the inbox being read and when was it
 * last checked, who has which address, and the last emails in and out with what each became.
 * And the Assign page's "From email" card: work someone emailed in, waiting for a person to
 * confirm it — nothing an email says is assigned until then.
 */

export function EmailTab({ viewer, tick }: { viewer: string; tick: number }) {
  const [o, setO] = useState<EmailOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    api.emailOverview(viewer).then(setO, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [viewer, tick, n]);
  if (err) return <Empty>{err}</Empty>;
  if (!o) return <Spinner label="Loading email…" />;

  const poll = o.lastPoll;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-mut">Sending</h3>
          <div className="flex items-center gap-2">
            <Pill tone={o.sending ? "ok" : "warn"}>{o.sending ? "on" : "off"}</Pill>
            <span className="text-sm">{o.sending ? "Notifications go by email to people who chose it." : "No SMTP settings in .env."}</span>
          </div>
        </Card>
        <Card>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-mut">Inbox</h3>
          <div className="flex items-center gap-2">
            <Pill tone={!o.receiving ? "warn" : poll && !poll.ok ? "crit" : "ok"}>{!o.receiving ? "off" : poll && !poll.ok ? "failing" : "reading"}</Pill>
            <span className="break-all text-sm">{o.inboxAddress ?? "No EMAIL_IMAP_* settings in .env."}</span>
          </div>
          <p className="mt-2 text-xs text-mut">
            {o.receiving
              ? poll
                ? `Last checked ${dmon(poll.at)} ${hhmm(poll.at)}${poll.ok ? "" : " — the check failed; see the worker window"}.`
                : "Not checked yet — is the worker running (and Redis)?"
              : "Replies by email are not read until the inbox is set up."}
          </p>
        </Card>
        <Card>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-mut">Allowed addresses</h3>
          {o.allowlist ? (
            <ul className="space-y-0.5 text-sm">{o.allowlist.map((a) => <li key={a} className="break-all">{a}</li>)}</ul>
          ) : (
            <p className="text-sm">Any employee&apos;s address (no EMAIL_ALLOWLIST set).</p>
          )}
          <p className="mt-2 text-xs text-mut">Email is never sent to, or accepted from, an address not on this list.</p>
        </Card>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Who has which address</h3>
        <div className="space-y-2">
          {o.people.map((p) => (
            <AddressRow key={p.id} viewer={viewer} person={p} onSaved={() => setN((x) => x + 1)} />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Recent emails</h3>
        <DataTable
          rows={o.recent}
          columns={[
            { head: "When", cell: (r) => `${dmon(r.at)} ${hhmm(r.at)}`, tight: true },
            { head: "", cell: (r) => <Pill>{r.direction === "in" ? "in" : "out"}</Pill>, tight: true },
            { head: "With", cell: (r) => <span className="break-all">{r.counterpart}</span> },
            { head: "Subject", cell: (r) => r.subject ?? "—" },
            { head: "Became", cell: (r) => <Pill tone={r.status === "refused" ? "crit" : r.status === "ignored" ? "warn" : "ok"}>{r.status}</Pill>, tight: true },
          ]}
          rowKey={(r) => r.id}
          detail={(r) => (r.reason || r.taskKey ? <div className="text-xs text-mut">{[r.taskKey, r.reason].filter(Boolean).join(" · ")}</div> : null)}
          empty="No email yet."
        />
      </section>
    </div>
  );
}

function AddressRow({ viewer, person, onSaved }: { viewer: string; person: EmailOverview["people"][number]; onSaved: () => void }) {
  const act = useAction();
  const [value, setValue] = useState(person.email ?? "");
  const changed = value.trim().toLowerCase() !== (person.email ?? "");
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[10rem] flex-1 text-sm font-semibold">{person.name}</div>
        <div className="min-w-[14rem] flex-[2]">
          <TextField label="Email" value={value} onChange={setValue} placeholder="not set" maxLength={254} />
        </div>
        <Button
          busy={act.busy}
          disabled={!changed}
          onClick={() =>
            void act.run(async () => {
              const r = await api.setEmployeeEmail(viewer, person.id, value.trim() || null);
              onSaved();
              return r.email ? `Saved ${r.email}.` : "Address removed.";
            })
          }
        >
          Save
        </Button>
      </div>
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
    </Card>
  );
}

/** Work emailed in, for a person to confirm. Shown on the Assign page to whoever may assign. */
export function EmailProposalsCard({ viewer, people, onChanged }: { viewer: string; people: Employee[]; onChanged: () => void }) {
  const [list, setList] = useState<EmailProposal[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    api.emailProposals(viewer).then((r) => setList(r.proposals), () => setList([]));
  }, [viewer, n]);
  if (!list || list.length === 0) return null;
  return (
    <Card>
      <h3 className="mb-3 text-sm font-semibold">✉️ From email — {list.length} waiting for you</h3>
      <div className="space-y-4">
        {list.map((p) => (
          <ProposalItem
            key={p.id}
            viewer={viewer}
            proposal={p}
            people={people.filter((x) => x.status === "active")}
            onDone={() => {
              setN((x) => x + 1);
              onChanged();
            }}
          />
        ))}
      </div>
    </Card>
  );
}

function ownerLabel(t: EmailProposal["tasks"][number]): string {
  if (t.assigneeId && t.matchedBy === "ai") return t.namedAs && t.namedAs !== t.assigneeName ? `Owner — my guess for "${t.namedAs}"; check it` : "Owner — my guess; check it";
  if (t.assigneeId) return "Owner (named in the email)";
  if (t.candidates.length > 1) return `Owner — "${t.namedAs ?? ""}" could be ${t.candidates.map((c) => c.name).join(" or ")}; choose`;
  return t.namedAs ? `Owner — the email said "${t.namedAs}", who is not on the list` : "Owner — nobody named";
}

function ProposalItem({ viewer, proposal, people, onDone }: { viewer: string; proposal: EmailProposal; people: Employee[]; onDone: () => void }) {
  const act = useAction();
  const [owners, setOwners] = useState<string[]>(proposal.tasks.map((t) => t.assigneeId ?? ""));
  const ready = owners.every((o) => o !== "");
  return (
    <div className="rounded-lg border border-edge p-3">
      <div className="text-xs text-mut">
        From <b className="text-ink">{proposal.fromName}</b> · {dmon(proposal.createdAt)} {hhmm(proposal.createdAt)}
        {proposal.subject ? <> · &ldquo;{proposal.subject}&rdquo;</> : null}
      </div>
      {proposal.summary ? <p className="mt-1 text-sm">{proposal.summary}</p> : null}
      <div className="mt-2 space-y-2">
        {proposal.tasks.map((t, i) => (
          <div key={i} className="rounded-md bg-panel/50 p-2">
            <div className="text-sm font-semibold">{t.title}</div>
            {t.detail ? <div className="text-xs text-mut">{t.detail}</div> : null}
            <div className="mt-1 max-w-sm">
              <PersonPicker label={ownerLabel(t)} value={owners[i] ?? ""} onChange={(v) => setOwners((prev) => prev.map((o, j) => (j === i ? v : o)))} people={people} />
            </div>
          </div>
        ))}
      </div>
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          tone="primary"
          busy={act.busy}
          disabled={!ready}
          onClick={() =>
            void act.run(async () => {
              const r = await api.applyEmailProposal(viewer, proposal.id, proposal.tasks.map((t, i) => ({ title: t.title, detail: t.detail, assignedTo: owners[i]! })));
              onDone();
              return `Assigned ${r.assigned.length} task(s). Each person is told on the channels they use.`;
            })
          }
        >
          Assign &amp; notify
        </Button>
        <Button
          busy={act.busy}
          onClick={() =>
            void act.run(async () => {
              await api.dismissEmailProposal(viewer, proposal.id);
              onDone();
              return "Dismissed — nothing was assigned.";
            })
          }
        >
          Dismiss
        </Button>
      </div>
      {!ready ? <p className="mt-2 text-xs text-mut">Choose an owner for every task first.</p> : null}
    </div>
  );
}
