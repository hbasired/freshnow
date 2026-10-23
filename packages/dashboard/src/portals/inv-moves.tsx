import { useCallback, useEffect, useState } from "react";
import { Card, Empty, Pill, Spinner } from "../components/ui";
import { KIND_WORDS, REASON_WORDS, amount, inv, type DocCard } from "../lib/inventory-api";
import { Sheet, errorText, when } from "./inv-ui";

/**
 * Every stock document, newest first (TASK-060): who, what, from where to where, and what happened to
 * it. Each one opens to its lines, its photos and — for an approver — the way to reverse a mistake.
 * Nothing here is ever edited: a correction is a new document in this same list.
 */

const KIND_ICON: Record<string, string> = { receipt: "📦", handover: "🤝", use: "🧴", damage: "🗑️", count_adjustment: "🔢", reversal: "↩️" };
const STATE: Record<string, { label: string; tone: "mut" | "ok" | "warn" | "crit" }> = {
  posted: { label: "Recorded", tone: "ok" },
  reversed: { label: "Reversed", tone: "mut" },
  waiting: { label: "Waiting to be confirmed", tone: "warn" },
  accepted: { label: "Confirmed", tone: "ok" },
  part_accepted: { label: "Less arrived", tone: "crit" },
  settled: { label: "Settled", tone: "mut" },
  refused: { label: "Refused", tone: "crit" },
  cancelled: { label: "Cancelled", tone: "mut" },
};

const dayOf = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));

export default function MovesView({ viewer, liveTick, onReverse }: { viewer: string; liveTick: number; onReverse: (doc: DocCard) => void }) {
  const [docs, setDocs] = useState<DocCard[] | null>(null);
  const [more, setMore] = useState(false);
  // Where the next page starts: the server's exact (time, id) of the last document shown.
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("");
  const [open, setOpen] = useState<DocCard | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await inv.movements(viewer, kind ? { kind } : {});
      setDocs(r.docs);
      setMore(r.more);
      setCursor(r.cursor);
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  }, [viewer, kind]);
  useEffect(() => {
    void load();
  }, [load, liveTick]);

  const older = async () => {
    if (!docs?.length || !cursor) return;
    try {
      const r = await inv.movements(viewer, { ...(kind ? { kind } : {}), before: cursor });
      setDocs([...docs, ...r.docs]);
      setMore(r.more);
      setCursor(r.cursor);
    } catch (e) {
      setErr(errorText(e));
    }
  };

  let lastDay = "";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
        {["", "receipt", "handover", "use", "damage", "count_adjustment", "reversal"].map((k) => (
          <button
            key={k || "all"}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={`min-h-10 rounded-xl border px-3 text-sm font-semibold ${kind === k ? "border-ok bg-ok/10" : "border-edge bg-panel hover:border-link"}`}
          >
            {k ? `${KIND_ICON[k]} ${KIND_WORDS[k]}` : "Everything"}
          </button>
        ))}
      </div>
      {err ? <Empty>{err}</Empty> : null}
      {!docs && !err ? <Spinner label="Loading movements…" /> : null}
      {docs && docs.length === 0 ? <Empty>Nothing yet.</Empty> : null}
      <ul className="space-y-2">
        {docs?.map((d) => {
          const day = dayOf(d.recordedAt);
          const head = day !== lastDay ? <li key={`h-${d.id}`} className="px-1 pt-2 text-xs font-bold uppercase tracking-widest text-mut">{day}</li> : null;
          lastDay = day;
          const s = STATE[d.state] ?? { label: d.state, tone: "mut" as const };
          return [
            head,
            <li key={d.id}>
              <button onClick={() => setOpen(d)} className="w-full text-left">
                <Card className="hover:border-link">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold">
                      {KIND_ICON[d.kind]} {KIND_WORDS[d.kind]} · {d.from.name} → {d.to.name}
                    </div>
                    <Pill tone={s.tone}>{s.label}</Pill>
                  </div>
                  <div className="mt-1 text-sm">{d.lines.map((l) => `${l.icon ?? ""} ${amount(l.qty, l.unit)} ${l.name}`).join(" · ")}</div>
                  <div className="text-xs text-mut">
                    {when(d.recordedAt)} · by {d.createdBy.name}
                    {d.reason ? ` · ${REASON_WORDS[d.reason] ?? d.reason}` : ""}
                    {d.photos.length ? ` · 📷 ${d.photos.length}` : ""}
                  </div>
                </Card>
              </button>
            </li>,
          ];
        })}
      </ul>
      {more ? (
        <button onClick={older} className="min-h-12 w-full rounded-xl border border-edge bg-panel font-semibold hover:border-link">
          Older
        </button>
      ) : null}
      {open ? <DocSheet viewer={viewer} doc={open} onClose={() => setOpen(null)} onReverse={(d) => { setOpen(null); onReverse(d); }} /> : null}
    </div>
  );
}

function DocSheet({ viewer, doc, onClose, onReverse }: { viewer: string; doc: DocCard; onClose: () => void; onReverse: (d: DocCard) => void }) {
  const s = STATE[doc.state] ?? { label: doc.state, tone: "mut" as const };
  return (
    <Sheet title={`${KIND_ICON[doc.kind]} ${KIND_WORDS[doc.kind]}`} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={s.tone}>{s.label}</Pill>
        <span className="text-sm text-mut">
          {when(doc.recordedAt)} · by {doc.createdBy.name}
        </span>
      </div>
      <p className="font-semibold">
        {doc.from.name} → {doc.to.name}
      </p>
      <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
        {doc.lines.map((l) => (
          <li key={l.itemId} className="p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">
                {l.icon} {l.name}
              </span>
              <span className="font-bold tabular-nums">{amount(l.qty, l.unit)}</span>
            </div>
            {doc.kind === "handover" ? (
              <div className="text-xs text-mut">
                {l.accepted ? `${amount(l.accepted, l.unit)} accepted` : "none accepted yet"}
                {l.pending ? ` · ${amount(l.pending, l.unit)} still in transit` : ""}
                {l.back ? ` · ${amount(l.back, l.unit)} went back` : ""}
                {l.writtenOff ? ` · ${amount(l.writtenOff, l.unit)} written off` : ""}
              </div>
            ) : null}
            {l.variety || l.cartonKg ? (
              <div className="text-xs text-mut">
                {l.variety ? `Variety ${l.variety}` : ""}
                {l.variety && l.cartonKg ? " · " : ""}
                {l.cartonKg ? `${l.cartonKg} kg a carton` : ""}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <dl className="space-y-1 text-sm">
        {doc.supplier ? <Row k="Supplier" v={doc.supplier} /> : null}
        {doc.invoiceNo ? <Row k="Invoice" v={doc.invoiceNo} /> : null}
        {doc.machine ? <Row k="Machine" v={`${doc.machine.assetNo ?? ""} ${doc.machine.label}`} /> : null}
        {doc.reason ? <Row k="Why" v={REASON_WORDS[doc.reason] ?? doc.reason} /> : null}
        {doc.note ? <Row k="Note" v={doc.note} /> : null}
        {doc.confirm ? <Row k="Confirmed by" v={doc.answeredBy ? `${doc.answeredBy.name}, ${when(doc.answeredAt!)}` : doc.confirm.side === "warehouse" ? "the warehouse — not yet" : `${doc.confirm.person?.name ?? "—"} — not yet`} /> : null}
        {doc.answerReason ? <Row k="Their reason" v={REASON_WORDS[doc.answerReason] ?? doc.answerReason} /> : null}
        {doc.answerNote ? <Row k="Their words" v={doc.answerNote} /> : null}
        {doc.settledBy ? <Row k="Settled by" v={`${doc.settledBy.name}, ${when(doc.settledAt!)}`} /> : null}
        {doc.reversedByDocId ? <Row k="Reversed" v="yes — the reversal is in the list" /> : null}
        {doc.reversesDocId ? <Row k="Reverses" v="an earlier document — the original stays, marked reversed" /> : null}
      </dl>
      {doc.photos.length ? (
        <div className="grid grid-cols-3 gap-2">
          {doc.photos.map((id) => (
            <a key={id} href={`/dashboard/media/${id}?viewer=${encodeURIComponent(viewer)}`} target="_blank" rel="noreferrer">
              <img src={`/dashboard/media/${id}?variant=thumb&viewer=${encodeURIComponent(viewer)}`} alt="A photo attached to this document" className="aspect-square w-full rounded-lg border border-edge object-cover" />
            </a>
          ))}
        </div>
      ) : null}
      {doc.may.reverse ? (
        <button onClick={() => onReverse(doc)} className="min-h-12 w-full rounded-xl border border-crit/50 bg-crit/10 font-semibold text-crit">
          Reverse this — it was a mistake
        </button>
      ) : null}
    </Sheet>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-mut">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
