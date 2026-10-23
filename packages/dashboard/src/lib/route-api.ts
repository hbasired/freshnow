import { get, post } from "./api";

/**
 * The Route portal's calls (TASK-061 part 2) — /dashboard/route/* — and the shapes they return. The words are the
 * instruction sheet's (18 Oct). Every plan, stop and visit carries an id made here, so a tap sent twice posts once.
 */

export const STOP_TASKS = [
  "full_service",
  "half_service",
  "resort",
  "cash",
  "water_remove",
  "garbage_remove",
  "hot_water_clean",
  "deep_clean",
  "free_vend",
  "check",
  "other",
] as const;
export type StopTask = (typeof STOP_TASKS)[number];
export const EVIDENCE_KINDS = ["normal_photo", "resorting_photo", "dispenser_video", "other_photo"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type ShiftWindow = "day" | "night";

export const TASK_WORDS: Record<StopTask, string> = {
  full_service: "Full service",
  half_service: "Half service",
  resort: "Resort",
  cash: "Cash",
  water_remove: "Water remove",
  garbage_remove: "Kachara remove",
  hot_water_clean: "Clean with hot water",
  deep_clean: "Deep clean",
  free_vend: "Make free vend",
  check: "Check 🚨",
  other: "Other",
};
export const EVIDENCE_WORDS: Record<EvidenceKind, string> = {
  normal_photo: "Normal pic",
  resorting_photo: "Re-sorting pic",
  dispenser_video: "Video of the white fruit dispenser",
  other_photo: "Other",
};
export const EVIDENCE_ICON: Record<EvidenceKind, string> = { normal_photo: "📷", resorting_photo: "🍊", dispenser_video: "🎥", other_photo: "🧾" };

/** The proof a task usually needs — the sheet's columns (the planner can change it). */
export function proofFor(tasks: readonly StopTask[]): EvidenceKind[] {
  const out = new Set<EvidenceKind>();
  if (tasks.includes("full_service") || tasks.includes("half_service")) out.add("normal_photo");
  if (tasks.includes("resort")) out.add("resorting_photo");
  if (tasks.some((t) => ["check", "other", "free_vend", "garbage_remove", "water_remove", "hot_water_clean", "deep_clean"].includes(t)) && !out.has("normal_photo")) out.add("other_photo");
  return EVIDENCE_KINDS.filter((k) => out.has(k));
}

export interface StopVisit {
  id: string;
  employee: { id: string; name: string };
  startedAt: string;
  startedHow: "qr" | "typed";
  endedAt: string | null;
  tasksDone: StopTask[];
  evidence: EvidenceKind[];
}

export interface PlanStop {
  id: string;
  seq: number;
  machine: { id: string; assetNo: number | null; label: string; serviceShift: ShiftWindow | null };
  tasks: StopTask[];
  crates: number | null;
  instructions: string | null;
  evidence: EvidenceKind[];
  visits: StopVisit[];
  proofComplete: boolean;
  missing: EvidenceKind[];
}

export interface PlanCard {
  id: string;
  businessDate: string;
  shiftWindow: ShiftWindow;
  name: string;
  note: string | null;
  state: "active" | "cancelled";
  members: { id: string; name: string }[];
  stops: PlanStop[];
  crates: number;
  updatedBy: { id: string; name: string };
  updatedAt: string;
  may: { edit: boolean };
}

export interface VisitDetail {
  id: string;
  employee: { id: string; name: string };
  machine: { id: string; assetNo: number | null; label: string };
  startedAt: string;
  startedHow: "qr" | "typed";
  endedAt: string | null;
  tasksDone: StopTask[];
  note: string | null;
  stop: { id: string; planId: string; team: string; tasks: StopTask[]; instructions: string | null; evidence: EvidenceKind[] } | null;
  evidence: { id: string; kind: EvidenceKind; mediaId: string | null; addedAt: string }[];
  missing: EvidenceKind[];
  fills: { docId: string; items: string; state: string }[];
  cash: { docId: string; amountFils: number | null; state: string }[];
  may: { change: boolean; end: boolean };
}

export interface RouteHome {
  can: { plan: boolean; visit: boolean; cash: boolean; machines: boolean };
  round: { plans: PlanCard[]; days: string[] };
  openVisit: VisitDetail | null;
}

export interface RouteMachine {
  assetNo: number;
  label: string;
  serviceShift: ShiftWindow | null;
  serviceNote: string | null;
}

/** A visit the grid lists apart: off the plans, or on a stop taken off since, or a plan cancelled since. */
export type OffPlanVisit = StopVisit & { machine: { assetNo: number | null; label: string }; why: "off_plan" | "stop_removed" | "plan_cancelled" };

export interface GridRow {
  planId: string;
  team: string;
  shiftWindow: ShiftWindow;
  stop: PlanStop;
  televend: { refillAt: string | null; refillCups: number | null; collectionAt: string | null } | null;
  fill: { items: string; at: string } | null;
  cashCollected: boolean;
}

export interface StopIn {
  id: string;
  machineAssetNo: number;
  tasks: StopTask[];
  crates?: number | null;
  instructions?: string | null;
  evidence: EvidenceKind[];
}

const P = (viewer: string) => ({ viewer });

export const route = {
  home: (viewer: string) => get<RouteHome>("/dashboard/route/home", P(viewer)),
  plans: (viewer: string, date: string) => get<PlanCard[]>("/dashboard/route/plans", { viewer, date }),
  people: (viewer: string) => get<{ id: string; name: string; role: string }[]>("/dashboard/route/people", P(viewer)),
  machines: (viewer: string) => get<RouteMachine[]>("/dashboard/route/machines", P(viewer)),
  grid: (viewer: string, date: string) =>
    get<{ date: string; rows: GridRow[]; unplanned: OffPlanVisit[]; seesMachines: boolean }>("/dashboard/route/grid", { viewer, date }),
  visit: (viewer: string, id: string) => get<VisitDetail>(`/dashboard/route/visits/${id}`, P(viewer)),
  sticker: (viewer: string, token: string) => get<{ assetNo: number | null; label: string }>(`/dashboard/route/sticker/${token}`, P(viewer)),

  savePlan: (
    viewer: string,
    body: { id: string; businessDate: string; shiftWindow: ShiftWindow; name: string; note?: string; memberIds: string[]; stops: StopIn[] },
  ) => post<{ id: string; created: boolean; warnings: string[]; crates: number }>("/dashboard/route/plans", body, P(viewer)),
  cancelPlan: (viewer: string, id: string) => post<{ id: string }>(`/dashboard/route/plans/${id}/cancel`, undefined, P(viewer)),
  copyPlans: (viewer: string, fromDate: string, toDate: string) =>
    post<{ created: string[]; skipped: number; skippedPlans: { name: string; shiftWindow: ShiftWindow; why: "already_there" | "nobody_left" }[] }>(
      "/dashboard/route/plans/copy",
      { fromDate, toDate },
      P(viewer),
    ),
  setRule: (viewer: string, assetNo: number, shift: ShiftWindow | null, note?: string) =>
    post<{ assetNo: number; shift: ShiftWindow | null; note: string | null }>(`/dashboard/route/machines/${assetNo}/rule`, { shift, ...(note ? { note } : {}) }, P(viewer), "PUT"),

  start: (viewer: string, body: { id: string; machineAssetNo?: number; qrToken?: string }) =>
    post<{ visitId: string; machine: { assetNo: number | null; label: string }; stopId: string | null; replay: boolean }>("/dashboard/route/visits", body, P(viewer)),
  addEvidence: (viewer: string, visitId: string, kind: EvidenceKind, mediaId: string) =>
    post<VisitDetail>(`/dashboard/route/visits/${visitId}/evidence`, { kind, mediaId }, P(viewer)),
  removeEvidence: (viewer: string, visitId: string, evidenceId: string) =>
    post<VisitDetail>(`/dashboard/route/visits/${visitId}/evidence/${evidenceId}/remove`, undefined, P(viewer)),
  tasks: (viewer: string, visitId: string, tasks: StopTask[]) => post<VisitDetail>(`/dashboard/route/visits/${visitId}/tasks`, { tasks }, P(viewer)),
  fill: (viewer: string, visitId: string, body: { id: string; lines: { itemId: string; qty: number }[] }) =>
    post<VisitDetail>(`/dashboard/route/visits/${visitId}/fill`, body, P(viewer)),
  cash: (viewer: string, visitId: string, body: { id: string; amountFils: number; mediaIds: string[]; note?: string }) =>
    post<VisitDetail>(`/dashboard/route/visits/${visitId}/cash`, body, P(viewer)),
  end: (viewer: string, visitId: string, note?: string) =>
    post<{ visitId: string; missing: EvidenceKind[]; tasksLeft: StopTask[] }>(`/dashboard/route/visits/${visitId}/end`, note ? { note } : {}, P(viewer)),
};

/** "Mon 20 Oct" for a plan's day. */
export const dayLabel = (date: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/** Today in Dubai, and a day before or after it. */
/** The Dubai date of a moment, YYYY-MM-DD. */
export const dubaiDateOf = (iso: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(iso));

export function dubaiDay(offset = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(Date.now() + offset * 86_400_000));
}
