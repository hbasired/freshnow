import { useEffect, useState } from "react";
import { api, dmon, hhmm, type ComplianceEvidence, type PolicyFinding, type RegistryServiceRow } from "../lib/api";
import { Card, DataTable, Empty, Pill, Spinner } from "./ui";

/**
 * Policy as code, for the CEO: which rules would stop production, where personal data can go and
 * on what ground, and the counts that prove it — consent by notice version, calls to each AI
 * service with the identifiers removed before sending, messages per channel, retention, and the
 * requests people have made. Every number comes from the API's SQL; nothing is computed here.
 */

const RULE: Record<PolicyFinding["rule"], string> = {
  R0: "The registry itself",
  R1: "Every service is registered",
  R2: "A legal ground, and the contract",
  R3: "Where the database lives",
  R4: "AI services keep nothing",
  R5: "The notice names it",
  R6: "Production essentials",
};

const DPA: Record<RegistryServiceRow["dpa"]["status"], string> = {
  accepted: "filed",
  not_filed: "not filed yet",
  not_available: "none offered",
};

export function ComplianceTab({ viewer, tick }: { viewer: string; tick: number }) {
  const [e, setE] = useState<ComplianceEvidence | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.compliance(viewer)
      .then((r) => { if (!cancelled) { setE(r); setErr(null); } })
      .catch((x: unknown) => { if (!cancelled) setErr(x instanceof Error ? x.message : "Could not load the compliance record"); });
    return () => { cancelled = true; };
  }, [viewer, tick]);

  if (err) return <Empty>{err}</Empty>;
  if (!e) return <Spinner label="Checking…" />;

  const blocks = e.policy.findings.filter((f) => f.level === "block");
  const warns = e.policy.findings.filter((f) => f.level === "warn");
  const tone = e.policy.production ? (blocks.length ? "crit" : "ok") : "warn";
  const reachable = new Set(e.policy.reachable);

  return (
    <div className="space-y-5">
      {/* The verdict first. */}
      <div className={`rounded-2xl border-l-4 p-4 ${tone === "crit" ? "border-crit bg-crit/10" : tone === "ok" ? "border-ok bg-ok/10" : "border-warn bg-high-bg"}`}>
        <div className="text-base font-bold">
          {e.policy.production
            ? blocks.length
              ? `Production — ${blocks.length} rule(s) failing. The services refuse to start until they pass.`
              : "Production — every rule passes."
            : `Demo — reported, not enforced. ${blocks.length} rule(s) would stop production.`}
        </div>
        <p className="mt-1 text-sm text-mut">
          The rules are checked against <code>compliance/processors.json</code>
          {e.registry ? ` (reviewed ${e.registry.reviewed_on})` : ""} every time the api, worker and bot start, and here whenever you open this page.
          {warns.length ? ` ${warns.length} warning(s) do not block.` : ""}
          {e.lastSnapshotAt ? ` Last daily snapshot in the audit log: ${dmon(e.lastSnapshotAt)} ${hhmm(e.lastSnapshotAt)}.` : " No daily snapshot yet — the worker writes one each day."}
        </p>
      </div>

      {e.policy.findings.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">What would stop production, and how to fix it</h3>
          <ul className="space-y-2">
            {e.policy.findings.map((f, i) => (
              <li key={i} className="rounded-xl border border-edge bg-panel p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] font-bold">{f.rule}</span>
                  <span className="text-xs text-mut">{RULE[f.rule]}</span>
                  <Pill tone={f.level === "block" ? "crit" : "warn"}>{f.level === "block" ? "blocks production" : "warning"}</Pill>
                  {f.service ? <Pill>{f.service}</Pill> : null}
                </div>
                <p className="mt-1.5">{f.message}</p>
                <p className="mt-1 text-xs text-mut">→ {f.fix}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="mb-1 text-sm font-semibold">Where personal data can go</h3>
        <p className="mb-2 text-xs text-mut">
          The record of processing. Host: <b className="text-ink">{e.registry?.hosting.name ?? "—"}</b> ({e.registry?.hosting.country ?? "?"}) ·
          retention: <b className="text-ink">{e.retention.days ? `${e.retention.days} days` : "not set"}</b>.
          “Reachable” means this server has the keys to send there right now.
        </p>
        {e.registry ? (
          <DataTable
            rows={e.registry.services}
            rowKey={(s) => s.id}
            columns={[
              { head: "Service", cell: (s) => (<span>{s.name} {reachable.has(s.id) ? <Pill tone="warn">reachable</Pill> : null}</span>) },
              { head: "Country", cell: (s) => s.country },
              { head: "Ground", cell: (s) => s.ground.join(" + ").replace(/_/g, " "), tight: true },
              { head: "Contract", cell: (s) => (<Pill tone={s.dpa.status === "accepted" ? "ok" : s.dpa.status === "not_available" ? "crit" : "warn"}>{DPA[s.dpa.status]}{s.dpa.accepted_on ? ` ${s.dpa.accepted_on}` : ""}</Pill>), tight: true },
              {
                head: "Keeps nothing",
                cell: (s) => (s.controls.zero_data_retention === undefined ? "—" : s.controls.zero_data_retention ? `yes · ${s.controls.confirmed_on ?? "undated"}` : "not confirmed"),
                tight: true,
              },
            ]}
            detail={(s) => <p className="text-xs text-mut">{s.how_to_confirm}</p>}
            empty="The registry lists no services."
          />
        ) : (
          <Empty>The registry could not be read — see the R0 finding above.</Empty>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <h3 className="mb-2 text-sm font-semibold">Consent · notice {e.consent.version}</h3>
          <div className="text-3xl font-bold">{e.consent.current}<span className="text-base font-normal text-mut"> of {e.consent.people}</span></div>
          <p className="mt-1 text-xs text-mut">people who use the system have agreed to the notice as it reads today · {e.consent.older} on an older version · {e.consent.none} never. Until someone agrees, nothing of theirs leaves the database.</p>
        </Card>
        <Card>
          <h3 className="mb-2 text-sm font-semibold">Sent to AI services · {e.days} days</h3>
          {e.ai.length ? (
            <ul className="space-y-1 text-sm">
              {e.ai.map((a) => (
                <li key={a.provider} className="flex justify-between gap-2">
                  <span>{a.provider}</span>
                  <span className="text-mut">{a.calls} calls · <b className="text-ink">{a.redacted}</b> identifier(s) removed</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-mut">No AI calls.</p>}
          <p className="mt-2 text-xs text-mut">Phone numbers, emails, Emirates IDs, IBANs and card numbers are taken out before any prompt leaves (names stay — routing needs them).</p>
        </Card>
        <Card>
          <h3 className="mb-2 text-sm font-semibold">Rights and retention · {e.days} days</h3>
          <ul className="space-y-1 text-sm">
            <li>{e.rights.exports} data download(s)</li>
            <li>{e.rights.erasures} person(s) erased (anonymised)</li>
            <li>{e.rights.withdrawals} consent withdrawal(s)</li>
            <li>{e.retention.notesAged} note(s) aged out · last {e.retention.lastAgedAt ? dmon(e.retention.lastAgedAt) : "never"}</li>
          </ul>
          <p className="mt-2 text-xs text-mut">Messages sent: {e.channels.length ? e.channels.map((c) => `${c.channel} ${c.sent}${c.held ? ` (+${c.held} waiting)` : ""}`).join(" · ") : "none"}.</p>
        </Card>
      </div>

      <p className="text-xs text-mut">
        What code cannot do: sign a contract, decide what the law means, or see a setting inside another company's console. The registry records what a
        person confirmed and when; the system refuses production until they have. <code>pnpm compliance --production</code> shows the same checks in a terminal.
      </p>
    </div>
  );
}
