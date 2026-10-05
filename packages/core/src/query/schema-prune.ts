/**
 * Schema pruning for the question box — only the tables a question needs (CLAUDE.md: "never
 * paste the whole schema into a prompt. Select only the tables a question needs").
 *
 * Deterministic: each table lists the words that signal it ("blocker", "problem", "broken" →
 * blocker), and the tables it joins through are added with it, so a pruned schema is still one
 * a correct query can be written against. Names always need `employee`. A question that signals
 * nothing in particular gets the everyday four (who, what work, what they said, what is broken).
 * The selection is returned so it can be shown and recorded — "which tables was the model shown?"
 * has an answer.
 */

interface TableDoc {
  line: string;
  words: readonly string[];
  /** Tables a query over this one usually joins through. */
  needs: readonly string[];
}

export const TABLE_DOCS: Record<string, TableDoc> = {
  employee: {
    line: "employee(id uuid, display_name text, department text, role_title text, site text, shift text, language text, status text, manager_employee_id uuid->employee.id)",
    words: ["who", "employee", "person", "people", "staff", "team", "manager", "department", "reports to", "worker"],
    needs: [],
  },
  task: {
    line: 'task(id uuid, task_number bigint "shown as FN-<number>", employee_id uuid->employee.id, title text, status text)',
    words: ["task", "job", "work", "fn-", "doing", "finished", "done", "open", "overdue", "progress", "complete"],
    needs: ["employee"],
  },
  task_update: {
    line: 'task_update(id uuid, task_id uuid->task.id, employee_id uuid->employee.id, status text[done|pending|blocker|in_progress], note_raw text "EXACTLY what the employee typed or said, in their own words — THIS is what someone said about their work", note_parsed jsonb "extraction; note_parsed->>\'summary\' is a one-line English summary", channel text[telegram|web|email], submitted_at timestamptz)',
    words: ["said", "say", "report", "update", "mention", "wrote", "told", "note", "status", "today", "yesterday", "message", "email"],
    needs: ["employee", "task"],
  },
  blocker: {
    line: "blocker(id uuid, task_update_id uuid->task_update.id, raised_by uuid->employee.id, assigned_resolver uuid->employee.id, category text[equipment|supply|staffing|quality|logistics|safety|other], severity text[low|medium|high|critical], status text[open|acknowledged|resolved|cancelled], affected_asset text \"the specific asset e.g. 'van 2 chiller' — NOT the category\", risk text, raised_at timestamptz)",
    words: ["blocker", "problem", "issue", "broken", "stuck", "block", "severity", "critical", "equipment", "supply", "safety", "quality", "logistics", "staffing", "fault", "chiller", "machine", "resolved"],
    needs: ["employee", "task_update"],
  },
  assignment: {
    line: 'assignment(id uuid, task_id uuid->task.id, assigned_by uuid->employee.id, assigned_to uuid->employee.id, note text "what the CEO asked for", status text, created_at timestamptz)',
    words: ["assign", "gave", "given", "asked", "instruction", "delegat"],
    needs: ["employee", "task"],
  },
  voice_asset: {
    line: 'voice_asset(id uuid, employee_id uuid->employee.id, transcript_raw text "what a voice note said", created_at timestamptz)',
    words: ["voice", "audio", "spoke", "recording", "transcript"],
    needs: ["employee"],
  },
  escalation: {
    line: "escalation(id uuid, blocker_id uuid->blocker.id, level int, reason text, created_at timestamptz)",
    words: ["escalat", "level", "sla", "ignored", "unanswered"],
    needs: ["blocker", "employee"],
  },
  routing_rule: {
    line: "routing_rule(id uuid, category text, resolver_employee_id uuid->employee.id)",
    words: ["route", "routing", "resolver", "responsible", "who handles", "who fixes"],
    needs: ["employee"],
  },
};

const EVERYDAY = ["employee", "task", "task_update", "blocker"];

export function pruneSchema(question: string): { tables: string[]; text: string } {
  const q = question.toLowerCase();
  const picked = new Set<string>(["employee"]);
  for (const [name, doc] of Object.entries(TABLE_DOCS)) {
    if (name !== "employee" && doc.words.some((w) => q.includes(w))) picked.add(name);
  }
  if (picked.size === 1) for (const t of EVERYDAY) picked.add(t);
  // Close over joins: a table comes with the tables a query over it needs.
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of [...picked]) {
      for (const n of TABLE_DOCS[t]?.needs ?? []) {
        if (!picked.has(n)) {
          picked.add(n);
          grew = true;
        }
      }
    }
  }
  // Stable order (the declaration order), so the same question gives the same prompt.
  const tables = Object.keys(TABLE_DOCS).filter((t) => picked.has(t));
  return { tables, text: `Tables (Postgres):\n${tables.map((t) => TABLE_DOCS[t]!.line).join("\n")}` };
}
