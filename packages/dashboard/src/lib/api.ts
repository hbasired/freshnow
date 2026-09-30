/**
 * Typed client for the FreshNow dashboard API.
 *
 * Every read is scoped by `viewer`, and the server runs it under that person's RLS
 * context — so what comes back is what Postgres allows, not what this file asks for.
 * The types below describe the shape, not the permission.
 */

const KEY_PARAM = "k";

let accessToken: string | null = null;
let unauthorized: (() => void) | null = null;
let consentRequired: (() => void) | null = null;

/** Set by the auth layer after sign-in; every API call then carries it as a Bearer token. */
export function setAccessToken(t: string | null): void {
  accessToken = t;
}

/** Called when the API says the session is no longer valid, so the app can sign out. */
export function onUnauthorized(fn: () => void): void {
  unauthorized = fn;
}

/**
 * Called when the API refuses data because the person has not agreed to the notice as it reads
 * today — for instance when it changed while the app was open. The app then shows the notice.
 */
export function onConsentRequired(fn: () => void): void {
  consentRequired = fn;
}

/** The refusal body every route sends, read once so both the code and the message are kept. */
async function refusal(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return body.error ?? {};
  } catch {
    return {};
  }
}

function authHeaders(): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

/**
 * The headers and query string every call carries, exposed so the live-update stream can
 * authenticate the same way the rest of the client does.
 *
 * This exists because `EventSource` cannot send an Authorization header — its only way to
 * carry a token is the URL, where it would land in every access log and proxy cache. The
 * stream therefore uses `fetch` with a streaming body instead, and needs these.
 */
export function requestContext(params: Record<string, string> = {}): { headers: Record<string, string>; query: string } {
  const key = dashboardKey();
  const qs = new URLSearchParams(params);
  if (key) qs.set(KEY_PARAM, key);
  return {
    headers: { ...(key ? { "X-Dashboard-Key": key } : {}), ...authHeaders() },
    query: qs.toString(),
  };
}

/** Optional shared secret, when the API has DASHBOARD_TOKEN set. Taken from the URL once. */
function dashboardKey(): string | null {
  const fromUrl = new URLSearchParams(location.search).get(KEY_PARAM);
  if (fromUrl) {
    try {
      sessionStorage.setItem("fn.key", fromUrl);
    } catch {
      /* private mode — the in-memory value still works for this page load */
    }
    return fromUrl;
  }
  try {
    return sessionStorage.getItem("fn.key");
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params);
  const key = dashboardKey();
  if (key) qs.set(KEY_PARAM, key);
  const res = await fetch(`${path}?${qs}`, {
    headers: { ...(key ? { "X-Dashboard-Key": key } : {}), ...authHeaders() },
  });
  if (!res.ok) {
    if (res.status === 401) unauthorized?.();
    const why = res.status === 403 ? await refusal(res) : {};
    if (why.code === "consent_required") consentRequired?.();
    throw new ApiError(
      res.status,
      res.status === 401
        ? "Not signed in — sign in again (or add ?k=… if this dashboard uses a key)."
        : res.status === 403
          ? (why.message ?? "This account is not linked to an active employee.")
          : `Request failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

async function post<T>(path: string, body?: unknown, params: Record<string, string> = {}, method = "POST"): Promise<T> {
  const key = dashboardKey();
  // Writes carry the viewer too. Under real sign-in the server ignores it and uses the
  // token; in demo mode, where the header lets you look through anyone's eyes, a write
  // must be attributed to the person you are currently looking as — not silently to the CEO.
  const qs = new URLSearchParams(params);
  if (key) qs.set(KEY_PARAM, key);
  const init: RequestInit = {
    method,
    headers: {
      // The JSON content-type goes with a body, never without one: Fastify refuses an
      // empty body that claims to be JSON (400), which silently broke every body-less
      // POST from the browser — acknowledge, generate reports — while the route tests,
      // which send no content-type, stayed green.
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "X-Dashboard-Key": key } : {}),
      ...authHeaders(),
    },
  };
  // Only set a body when there is one — `exactOptionalPropertyTypes` treats an explicit
  // `undefined` as a different thing from an absent property, and it is right to.
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${path}?${qs}`, init);
  if (!res.ok) {
    if (res.status === 401) unauthorized?.();
    // A refusal says why ("Only the CEO can assign work"); show that, not a status code.
    const why = await refusal(res);
    if (why.code === "consent_required") consentRequired?.();
    throw new ApiError(res.status, why.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** A file upload. The browser sets the multipart boundary itself, so no content-type here. */
async function postForm<T>(path: string, form: FormData, params: Record<string, string> = {}): Promise<T> {
  const key = dashboardKey();
  const qs = new URLSearchParams(params);
  if (key) qs.set(KEY_PARAM, key);
  const res = await fetch(`${path}?${qs}`, {
    method: "POST",
    headers: { ...(key ? { "X-Dashboard-Key": key } : {}), ...authHeaders() },
    body: form,
  });
  if (!res.ok) {
    if (res.status === 401) unauthorized?.();
    const why = await refusal(res);
    if (why.code === "consent_required") consentRequired?.();
    throw new ApiError(res.status, why.message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch a file the API sends as an attachment and hand it to the browser as a download. A plain
 * link cannot carry the sign-in token, so the file comes through fetch and a temporary object URL.
 */
async function download(path: string, params: Record<string, string>, fallbackName: string): Promise<string> {
  const ctx = requestContext(params);
  const res = await fetch(`${path}?${ctx.query}`, { headers: ctx.headers });
  if (!res.ok) {
    if (res.status === 401) unauthorized?.();
    const why = await refusal(res);
    throw new ApiError(res.status, why.message ?? `Request failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

// ── Shapes ──────────────────────────────────────────────────────────────────
export interface Employee {
  id: string;
  display_name: string;
  department: string | null;
  role_title: string | null;
  site: string | null;
  shift: string | null;
  status: string;
  is_synthetic: boolean;
  /** Whether the bot can reach them on Telegram. */
  linked: boolean;
  access_role: AccessRole;
  manager_employee_id: string | null;
  manager_name: string | null;
}

export type AccessRole = "ceo" | "manager" | "lead" | "employee";

export interface DayUpdate {
  id: string;
  status: string;
  note_raw: string | null;
  summary: string | null;
  submitted_at: string;
  is_synthetic: boolean;
  employee_name: string;
  department: string | null;
  task_id: string | null;
  task_title: string | null;
  task_status: string | null;
  blocker_id: string | null;
  severity: string | null;
  category: string | null;
  blocker_status: string | null;
  files: number;
}

export interface OpenTask {
  id: string;
  employee_id: string;
  title: string;
  status: string;
  created_at: string;
  is_synthetic: boolean;
  employee_name: string;
  department: string | null;
  opened_on: string;
  age_days: number;
  last_note: string | null;
  last_reported_at: string | null;
  progress_pct: number;
  progress_source: ProgressSource;
  /** The range a person picked ("10–20%"); null otherwise. When set, show it — not the midpoint. */
  progress_band_low: number | null;
  progress_band_high: number | null;
  priority: Priority;
  due_at: string | null;
  started_at: string | null;
  /** How much of the start→due window has passed, 0–100; null without both dates. */
  elapsed_pct: number | null;
  /** Elapsed time is further ahead than reported progress by more than the threshold. */
  behind: boolean;
}

export type ProgressSource = "counted" | "status" | "self_reported";

/** "10–20%" is `{ low: 10, high: 20 }`. */
export interface ProgressBand {
  low: number;
  high: number;
}

/**
 * The ranges a person picks from. The same ten steps as PROGRESS_BANDS in core, which the
 * API checks every submission against — a range not on this list is refused, not stored.
 * "100% — finished" is not here on purpose: finishing is reporting Done.
 */
export const PROGRESS_BANDS: readonly (ProgressBand & { hint: string })[] = [
  { low: 0, high: 10, hint: "just started" },
  { low: 10, high: 20, hint: "" },
  { low: 20, high: 30, hint: "about a quarter" },
  { low: 30, high: 40, hint: "" },
  { low: 40, high: 50, hint: "nearly half" },
  { low: 50, high: 60, hint: "just over half" },
  { low: 60, high: 70, hint: "" },
  { low: 70, high: 80, hint: "about three quarters" },
  { low: 80, high: 90, hint: "" },
  { low: 90, high: 100, hint: "almost finished" },
];

/**
 * How a task's percentage reads on screen: a picked range as the range ("10–20%"), anything
 * else as its number. The midpoint behind a range is for totals and is never shown as if it
 * were measured.
 */
export function progressLabel(t: { progress_pct: number; progress_band_low?: number | null; progress_band_high?: number | null }): string {
  return t.progress_band_low != null && t.progress_band_high != null
    ? `${t.progress_band_low}–${t.progress_band_high}%`
    : `${t.progress_pct}%`;
}

export type Priority = "low" | "normal" | "high" | "urgent";
export type RelationKind = "blocks" | "blocked_by" | "precedes" | "follows" | "relates" | "duplicates";

export interface TaskDetail {
  task: {
    id: string; title: string; details: string | null; status: string; status_category: string;
    resolution: string | null; resolved_at: string | null;
    progress_pct: number; progress_source: ProgressSource; progress_note: string | null; progress_updated_at: string | null;
    progress_band_low: number | null; progress_band_high: number | null;
    started_at: string | null; due_at: string | null; priority: Priority; estimate_minutes: number | null;
    parent_task_id: string | null; task_type: string; created_at: string; is_synthetic: boolean;
    employee_id: string; employee_name: string; elapsed_pct: number | null; behind: boolean; behind_threshold: number;
  };
  steps: { id: string; title: string; position: number; done: boolean; done_at: string | null; done_by_name: string | null }[];
  relations: { id: string; kind: RelationKind; to_task_id: string; other_title: string; other_status: string; other_owner: string | null }[];
  history: { pct: number; band_low: number | null; band_high: number | null; source: ProgressSource; note: string | null; created_at: string; by_name: string | null }[];
  blockers: { id: string; severity: string | null; category: string | null; status: string; raised_at: string; resolved_at: string | null; resolution_note: string | null; resolved_by_name: string | null; note_raw: string | null }[];
  subtasks: { id: string; title: string; status: string; progress_pct: number; progress_source: ProgressSource }[];
}

export interface Assignment {
  id: string;
  status: string;
  note: string | null;
  created_at: string;
  is_synthetic: boolean;
  task_title: string | null;
  task_status: string | null;
  assigned_by: string;
  assigned_to: string;
  files: number;
  file_names: string | null;
}

export interface EodReport {
  id: string;
  report_date: string;
  completed: number;
  pending: number;
  blockers: number;
  reports_made: number;
  summary: string | null;
  detail: {
    openTasks?: { title: string; age_days: number }[];
    carriedOver?: { title: string; age_days: number }[];
    silent?: { title: string; age_days: number }[];
    assignedToday?: { title: string; assigned_by: string }[];
    addendum?: string | null;
  } | null;
  generated_at: string;
  is_synthetic: boolean;
  employee_name: string;
}

export interface NeedsReview {
  id: string;
  note_raw: string | null;
  submitted_at: string;
  employee_name: string;
}

export interface Blocker {
  id: string;
  category: string | null;
  severity: string | null;
  status: string;
  affected_asset: string | null;
  raised_at: string;
  is_synthetic: boolean;
  raised_by_name: string;
}

/** One company day of the last seven, counted by Postgres under the viewer's rules. */
/** One delivery channel, with both gates resolved and a sentence explaining a shut one. */
export interface ChannelState {
  channel: "telegram" | "inapp" | "email" | "webpush" | "chat";
  available: boolean;
  enabled: boolean;
  live: boolean;
  why: string;
}

export interface WeekDay {
  day: string;
  completed: number;
  pending: number;
  blocked: number;
}

export interface ActivityRow {
  id: string;
  action: string;
  actor: string;
  entity: string | null;
  created_at: string;
  correlation_id: string | null;
}

export interface QueryAnswer {
  answer: string;
  sql: string | null;
  rowCount: number;
  abstained?: boolean;
  /** Both deterministic gates. A gate that ran and refused is shown, never hidden. */
  gate?: { numericSanity?: boolean; grounding?: boolean };
}

export interface Health {
  status: string;
  db: string;
  load: Record<string, { active: number; waiting: number; peakActive: number; peakWaiting: number; rejected: number }>;
}

export interface Me {
  viewer: string;
  /** The employee uuid behind the viewer; "ceo" is only a label. */
  employeeId: string;
  isCeo: boolean;
  /** What the browser may offer; the API refuses the rest regardless. */
  accessRole: AccessRole;
  department: string | null;
  displayName: string | null;
  authRequired: boolean;
  /** Whether this person has a Telegram account linked; the Telegram column follows it. */
  telegramLinked?: boolean;
}

/** Telegram only (default), Telegram + the app, or the app only — the company's one toggle. */
export type DeliveryMode = "telegram" | "both" | "app";

export interface ConsentState {
  /** Any consent on record, to any version of the notice. */
  consented: boolean;
  /** Consent to the notice as it reads today — the only kind the API accepts. */
  current: boolean;
  consentedAt: string | null;
  policyVersion: string | null;
  currentPolicyVersion: string;
  /** The exact words the app shows, and their hash — sent back on accept. */
  notice: string;
  noticeHash: string;
}

// ── Calls ───────────────────────────────────────────────────────────────────
/** Why a person is anonymised — the wording the audit row keeps. */
export type EraseReason = "left" | "consent_withdrawn" | "request";

export const api = {
  employees: (viewer: string) => get<Employee[]>("/dashboard/employees", { viewer }),
  day: (viewer: string, date: string) => get<DayUpdate[]>("/dashboard/day", { viewer, date }),
  week: (viewer: string, date: string) => get<WeekDay[]>("/dashboard/week", { viewer, date }),
  channels: (viewer: string) => get<{ channels: ChannelState[]; mode: DeliveryMode | "custom" }>("/dashboard/channels", { viewer }),
  setDeliveryMode: (viewer: string, mode: DeliveryMode) =>
    post<{ mode: DeliveryMode | "custom"; channels: ChannelState[] }>("/dashboard/channels/mode", { mode }, { viewer }, "PUT"),
  pushTest: (viewer: string) => post<{ queued: boolean }>("/dashboard/me/push-test", undefined, { viewer }),
  consent: (viewer: string) => get<ConsentState>("/dashboard/me/consent", { viewer }),
  giveConsent: (viewer: string, noticeHash: string) => post<ConsentState>("/dashboard/me/consent", { noticeHash }, { viewer }),
  withdrawConsent: (viewer: string) => post<{ withdrawn: boolean }>("/dashboard/me/consent/withdraw", undefined, { viewer }),
  subscribePush: (viewer: string, body: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string }) =>
    post<{ created: boolean }>("/dashboard/me/push-subscriptions", body, { viewer }),
  unsubscribePush: (viewer: string, endpoint: string) =>
    post<{ deleted: number }>("/dashboard/me/push-subscriptions", { endpoint }, { viewer }, "DELETE"),
  myDevices: (viewer: string) => get<{ devices: { id: string; userAgent: string | null; createdAt: string; lastSeenAt: string | null }[] }>("/dashboard/me/devices", { viewer }),
  setChannel: (viewer: string, channel: ChannelState["channel"], enabled: boolean) =>
    post<ChannelState>("/dashboard/channels", { channel, enabled }, { viewer }, "PUT"),
  openTasks: (viewer: string) => get<OpenTask[]>("/dashboard/open-tasks", { viewer }),
  assignments: (viewer: string) => get<Assignment[]>("/dashboard/assignments", { viewer }),
  eod: (viewer: string, date: string) => get<EodReport[]>("/dashboard/eod", { viewer, date }),
  needsReview: (viewer: string) => get<NeedsReview[]>("/dashboard/needs-review", { viewer }),
  blockers: (viewer: string) => get<Blocker[]>("/dashboard/blockers", { viewer }),
  activity: (viewer: string) => get<ActivityRow[]>("/dashboard/activity", { viewer }),
  health: () => get<Health>("/health"),
  me: (viewer?: string) => get<Me>("/dashboard/me", viewer ? { viewer } : {}),
  generateEod: () => post<{ generated: number; date: string | null }>("/dashboard/eod/generate"),
  /** Policy checks and their evidence — CEO only. */
  compliance: (viewer: string) => get<ComplianceEvidence>("/dashboard/compliance", { viewer }),
  /** Everything held about the signed-in person, saved as a JSON file. Returns the file name. */
  downloadMyData: (viewer: string) => download("/dashboard/me/export", { viewer }, "freshnow-my-data.json"),
  /** The CEO answering someone's request for their data. */
  downloadPersonData: (viewer: string, id: string) => download(`/dashboard/people/${id}/export`, { viewer }, "freshnow-data.json"),
  ask: (question: string) => post<QueryAnswer>("/dashboard/query", { question }),

  // ── Writes. Each one is the browser half of something the bot can already do. ──
  createTask: (viewer: string, body: { title: string; employeeId?: string }) =>
    post<{ taskId: string; employeeId: string }>("/dashboard/tasks", body, { viewer }),
  assign: (viewer: string, body: { assignedTo: string; title: string; note?: string }) =>
    post<AssignResult>("/dashboard/assignments", body, { viewer }),
  reportUpdate: (viewer: string, body: { taskId?: string | null; status: ReportedStatus; note?: string }) =>
    post<UpdateResult>("/dashboard/task-updates", body, { viewer }),
  ackBlocker: (viewer: string, blockerId: string) =>
    post<{ blockerId: string; status: string }>(`/dashboard/blockers/${blockerId}/ack`, undefined, { viewer }),
  taskDetail: (viewer: string, id: string) => get<TaskDetail>(`/dashboard/tasks/${id}`, { viewer }),
  addStep: (viewer: string, taskId: string, title: string) =>
    post<{ id: string }>(`/dashboard/tasks/${taskId}/steps`, { title }, { viewer }),
  setStep: (viewer: string, stepId: string, done: boolean) =>
    post<{ stepId: string; done: boolean }>(`/dashboard/steps/${stepId}`, { done }, { viewer }, "PATCH"),
  /** A range from the picker, or an exact figure — the server counts a range as its midpoint. */
  reportProgress: (viewer: string, taskId: string, amount: { band: ProgressBand } | { pct: number }, note: string) =>
    post<{ pct: number; band: ProgressBand | null }>(`/dashboard/tasks/${taskId}/progress`, { ...amount, note }, { viewer }),
  updateTask: (viewer: string, taskId: string, body: { priority?: Priority; dueAt?: string | null; estimateMinutes?: number | null; details?: string | null }) =>
    post<{ updated: boolean }>(`/dashboard/tasks/${taskId}`, body, { viewer }, "PATCH"),
  linkTasks: (viewer: string, taskId: string, toTaskId: string, kind: RelationKind) =>
    post<{ kind: string }>(`/dashboard/tasks/${taskId}/relations`, { toTaskId, kind }, { viewer }),
  closeTask: (viewer: string, taskId: string, resolution: "wont_do" | "duplicate" | "cancelled") =>
    post<{ status: string }>(`/dashboard/tasks/${taskId}/close`, { resolution }, { viewer }),
  resolveBlocker: (viewer: string, blockerId: string, note: string) =>
    post<{ status: string }>(`/dashboard/blockers/${blockerId}/resolve`, { note }, { viewer }),
  updatePerson: (viewer: string, id: string, body: { accessRole?: string; managerEmployeeId?: string | null; department?: string | null }) =>
    post<{ employeeId: string; updated: boolean }>(`/dashboard/people/${id}`, body, { viewer }, "PATCH"),
  erasePerson: (viewer: string, id: string, reason: EraseReason) =>
    post<{ employeeId: string; erased: boolean; notesRedacted: number; assignmentNotesRedacted: number }>(`/dashboard/people/${id}/erase`, { reason }, { viewer }),
  invite: (displayName: string) =>
    post<{ code: string; expiresAt: string }>("/employees/invite", { displayName }),
  planDocument: (viewer: string, file: File, instruction: string) => {
    const form = new FormData();
    if (instruction.trim()) form.append("instruction", instruction.trim());
    form.append("file", file, file.name);
    return postForm<DocumentPlan>("/dashboard/documents/plan", form, { viewer });
  },
  applyDocument: (viewer: string, body: { fileName: string; tasks: { assignedTo: string; title: string; detail?: string | null }[] }) =>
    post<{ assigned: { taskId: string; assignmentId: string; assignedTo: string; queued: boolean }[]; fileForwarded: boolean }>(
      "/dashboard/documents/apply",
      body,
      { viewer },
    ),

  // ── Alerts: who was told, what, and why — and how this person wants to be told. ──
  notifications: (viewer: string) => get<Inbox>("/dashboard/notifications", { viewer }),
  markRead: (viewer: string, ids?: string[]) =>
    post<{ marked: number }>("/dashboard/notifications/read", ids ? { ids } : {}, { viewer }),
  alerts: (viewer: string) => get<AlertRow[]>("/dashboard/alerts", { viewer }),
  ladder: (viewer: string) => get<LadderLevel[]>("/dashboard/escalation-policy", { viewer }),
  sla: (viewer: string) => get<SlaRow[]>("/dashboard/sla-policy", { viewer }),
  prefs: (viewer: string) => get<{ events: AlertEventType[]; prefs: Pref[] }>("/dashboard/me/notification-prefs", { viewer }),
  setPref: (viewer: string, body: Pref) => post<{ ok: boolean }>("/dashboard/me/notification-prefs", body, { viewer }, "PUT"),
  watchers: (viewer: string, taskId: string) => get<Watcher[]>(`/dashboard/tasks/${taskId}/watchers`, { viewer }),
  watch: (viewer: string, taskId: string) => post<{ added: boolean }>(`/dashboard/tasks/${taskId}/watch`, undefined, { viewer }),
  unwatch: (viewer: string, taskId: string) => post<{ ok: boolean }>(`/dashboard/tasks/${taskId}/watch`, undefined, { viewer }, "DELETE"),

  // ── Projects: the second portal. ──
  projects: (viewer: string) => get<ProjectRow[]>("/dashboard/projects", { viewer }),
  project: (viewer: string, id: string) => get<ProjectDetail>(`/dashboard/projects/${id}`, { viewer }),
  createProject: (viewer: string, body: NewProject) => post<{ projectId: string }>("/dashboard/projects", body, { viewer }),
  patchProject: (viewer: string, id: string, body: Partial<NewProject> & { status?: ProjectStatus }) =>
    post<{ updated: boolean }>(`/dashboard/projects/${id}`, body, { viewer }, "PATCH"),
  setHealth: (viewer: string, id: string, health: ProjectHealth, note: string) =>
    post<{ health: string }>(`/dashboard/projects/${id}/health`, { health, note }, { viewer }),
  addRequirement: (viewer: string, id: string, body: { text: string; kind?: RequirementKind; priority?: Moscow; acceptance?: string | null }) =>
    post<{ id: string }>(`/dashboard/projects/${id}/requirements`, body, { viewer }),
  setRequirement: (viewer: string, id: string, status: "open" | "met" | "dropped") =>
    post<{ status: string }>(`/dashboard/requirements/${id}`, { status }, { viewer }, "PATCH"),
  addMilestone: (viewer: string, id: string, body: { name: string; dueDate?: string | null; weight?: number }) =>
    post<{ id: string }>(`/dashboard/projects/${id}/milestones`, body, { viewer }),
  setMilestone: (viewer: string, id: string, status: "open" | "done" | "cancelled", force?: boolean) =>
    post<{ status: string; openTasks: number }>(`/dashboard/milestones/${id}`, force === undefined ? { status } : { status, force }, { viewer }, "PATCH"),
  addProjectMember: (viewer: string, id: string, employeeId: string, role?: MemberRole) =>
    post<{ added: boolean }>(`/dashboard/projects/${id}/members`, role ? { employeeId, role } : { employeeId }, { viewer }),
  removeProjectMember: (viewer: string, id: string, employeeId: string) =>
    post<{ removed: boolean }>(`/dashboard/projects/${id}/members`, { employeeId }, { viewer }, "DELETE"),
  addProjectUpdate: (viewer: string, id: string, body: { narrative: string; pctReported?: number | null; health?: ProjectHealth }) =>
    post<{ id: string; computedPct: number | null }>(`/dashboard/projects/${id}/updates`, body, { viewer }),
  raiseIssue: (viewer: string, id: string, body: { title: string; kind?: IssueKind; severity?: string; description?: string | null; ownerId?: string | null }) =>
    post<{ id: string }>(`/dashboard/projects/${id}/issues`, body, { viewer }),
  setIssue: (viewer: string, id: string, status: "resolved" | "accepted" | "mitigating", note: string) =>
    post<{ status: string }>(`/dashboard/issues/${id}`, { status, note }, { viewer }, "PATCH"),
  setTaskProject: (viewer: string, taskId: string, projectId: string | null, milestoneId?: string | null) =>
    post<{ projectId: string | null }>(`/dashboard/tasks/${taskId}/project`, { projectId, milestoneId: milestoneId ?? null }, { viewer }, "PATCH"),
};

export type ProjectStatus = "draft" | "active" | "on_hold" | "done" | "cancelled";
/** The project's own red/amber/green. Distinct from `Health`, which is the API's own health. */
export type ProjectHealth = "green" | "amber" | "red";
export type RequirementKind = "need" | "requirement" | "constraint" | "assumption";
export type Moscow = "must" | "should" | "could" | "wont";
export type IssueKind = "issue" | "risk" | "dependency" | "decision";
export type MemberRole = "sponsor" | "lead" | "member" | "watcher";

export interface NewProject {
  name: string;
  purpose?: string | null;
  code?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  leadEmployeeId?: string | null;
  sponsorEmployeeId?: string | null;
}

export interface ProjectRow {
  project_id: string;
  name: string;
  status: ProjectStatus;
  health: ProjectHealth;
  start_date: string | null;
  target_date: string | null;
  tasks_total: number;
  tasks_done: number;
  milestones_total: number;
  milestones_done: number;
  milestones_overdue: number;
  issues_open: number;
  issues_serious: number;
  /** Computed — always read `progress_source` with it. */
  progress_pct: number;
  progress_source: "milestones" | "tasks";
  schedule_elapsed_pct: number | null;
  last_update_at: string | null;
  lead_name: string | null;
  behind: boolean;
}

export interface ProjectDetail {
  project: {
    id: string; name: string; code: string | null; purpose: string | null; status: ProjectStatus;
    start_date: string | null; target_date: string | null; health: ProjectHealth;
    health_note: string | null; health_updated_at: string | null;
    lead_employee_id: string | null; sponsor_employee_id: string | null;
    lead_name: string | null; sponsor_name: string | null;
  };
  progress: (ProjectRow & { behind: boolean }) | null;
  flow: FlowMetrics | null;
  requirements: { id: string; kind: RequirementKind; text: string; priority: Moscow; acceptance: string | null; status: string; raised_by_name: string | null }[];
  milestones: { id: string; name: string; due_date: string | null; weight: number; status: string; tasks_total: number; tasks_done: number; overdue: boolean }[];
  tasks: { id: string; title: string; status: string; status_category: string; progress_pct: number; progress_source: string; priority: string; due_at: string | null; milestone_id: string | null; employee_id: string; employee_name: string }[];
  members: { employee_id: string; role: MemberRole; name: string }[];
  updates: { id: string; narrative: string; pct_reported: number | null; health: ProjectHealth | null; created_at: string; author_name: string | null }[];
  issues: { id: string; kind: IssueKind; title: string; description: string | null; severity: string; status: string; due_date: string | null; mitigation: string | null; resolution_note: string | null; resolved_at: string | null; created_at: string; owner_name: string | null; raised_by_name: string | null }[];
  may: { manage: boolean; contribute: boolean };
}

export interface FlowMetrics {
  wip: number;
  open_total: number;
  oldest_open_days: number | null;
  avg_open_days: number | null;
  throughput_7d: number;
  throughput_28d: number;
  cycle_p50_days: string | null;
  cycle_p85_days: string | null;
  cycle_p95_days: string | null;
  finished_total: number;
}

export type AlertEventType = "blocker.raised" | "blocker.escalated" | "blocker.resolved" | "task.assigned" | "task.done";

export interface Notification {
  id: string;
  at: string;
  readAt: string | null;
  /** The rule that chose this person — "resolver", "assignee", "escalation level 2 → ceo". */
  reason: string | null;
  text: string;
  kind: AlertEventType | string | null;
  blockerId: string | null;
  taskId: string | null;
  level: number | null;
}

export interface Inbox {
  unread: number;
  items: Notification[];
}

export interface AlertRow {
  id: string;
  state: "triggered" | "acknowledged" | "resolved";
  /** How many times the same problem was reported while this alert was open. */
  count: number;
  blockerId: string | null;
  about: string | null;
  category: string | null;
  severity: string | null;
  asset: string | null;
  firstSeen: string;
  lastSeen: string;
  ackedAt: string | null;
  ackedBy: string | null;
  escalationLevel: number | null;
}

export interface LadderLevel {
  level: number;
  afterMinutes: number;
  targets: string[];
}

export interface SlaRow {
  severity: string;
  minutes: number;
}

export interface Pref {
  eventType: AlertEventType;
  channel: "telegram" | "email" | "webpush";
  mode: "immediate" | "digest" | "off";
  delayMinutes?: number;
}

export interface Watcher {
  employeeId: string;
  name: string;
  reason: string;
  me: boolean;
}

export interface DocumentPlan {
  fileName: string;
  pages: number;
  truncated: boolean;
  safety: { verdict: "safe" | "suspicious" | "blocked"; reasons: string[]; mayForward: boolean };
  injection: { suspicious: boolean; labels: string[] };
  summary: string;
  needsOwner: boolean;
  tasks: { title: string; detail: string | null; assigneeId: string | null; assigneeName: string | null; namedAs: string | null }[];
  /** Always false from the browser today: attachments are Telegram file ids, and an upload has none. */
  fileForwarded: boolean;
}

export type ReportedStatus = "done" | "pending" | "blocker" | "in_progress";

export interface AssignResult {
  taskId: string;
  assignmentId: string;
  /** The message is queued for Telegram — the worker owns whether it arrives. */
  queued: boolean;
}

export interface UpdateResult {
  taskUpdateId: string;
  needsReview?: boolean;
  blockerId?: string;
  category?: string;
  severity?: string;
  summary?: string;
  alerted?: boolean;
}

/** Company time, matching the server. The browser's own zone is not the company's. */
export const COMPANY_TZ = "Asia/Dubai";

export function hhmm(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COMPANY_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function dmon(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COMPANY_TZ,
    day: "2-digit",
    month: "short",
  }).format(new Date(iso));
}

export function companyToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The COMPANY date of an instant, as `YYYY-MM-DD` for a `<input type="date">`.
 *
 * Not `iso.slice(0, 10)`. That is the UTC date, and Dubai is four hours ahead: anything
 * stored after 20:00 UTC belongs to the next day here. A date field filled by slicing
 * therefore disagreed with the same date rendered by `dmon()` a few pixels away, and
 * saving without touching it moved the deadline a day (found in review, 2026-09-18).
 */
export function companyDate(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * A `YYYY-MM-DD` the person typed, as an instant: midday in COMPANY time.
 *
 * Midday rather than midnight so that no display timezone can round it onto a
 * neighbouring day. The `+04:00` is written literally because Asia/Dubai has had a fixed
 * offset with no daylight saving since 1972 — a fact worth stating rather than hiding
 * behind an abstraction that implies it might vary.
 */
export function companyDateToIso(date: string): string | null {
  if (!date) return null;
  const d = new Date(`${date}T12:00:00+04:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Compliance (policy as code) ─────────────────────────────────────────────
export interface PolicyFinding {
  rule: "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
  level: "block" | "warn";
  service?: string;
  message: string;
  fix: string;
}

export interface RegistryServiceRow {
  id: string;
  name: string;
  role: string;
  country: string;
  personal_data: string[];
  ground: string[];
  dpa: { status: "accepted" | "not_filed" | "not_available"; accepted_on: string | null; note?: string };
  controls: { zero_data_retention?: boolean; data_collection?: "allow" | "deny"; confirmed_on?: string | null };
  how_to_confirm: string;
  sources: string[];
}

export interface ComplianceEvidence {
  generatedAt: string;
  days: number;
  policy: { production: boolean; refuse: boolean; findings: PolicyFinding[]; reachable: string[] };
  registry: {
    reviewed_on: string;
    hosting: { provider: string; name: string; country: string; note?: string };
    hosting_countries_allowed: string[];
    retention_days: number | null;
    services: RegistryServiceRow[];
  } | null;
  consent: { version: string; people: number; current: number; older: number; none: number };
  ai: { provider: string; calls: number; ok: number; redacted: number }[];
  channels: { channel: string; sent: number; held: number }[];
  retention: { days: number | null; lastAgedAt: string | null; notesAged: number };
  rights: { erasures: number; withdrawals: number; exports: number };
  lastSnapshotAt: string | null;
}
