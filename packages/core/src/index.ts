export { loadConfig, configSchema } from "./config.js";
export type { Config } from "./config.js";

export { PROJECT_NAME, IS_DEMO, DEMO_CEO_ID } from "./meta.js";

export { resolveRole, botRole } from "./roles.js";
export type { Role } from "./roles.js";

export { getAppSql, getServiceSql, withContext, closeDb } from "./db.js";
export type { Db, Tx, AppContext, AccessRole } from "./db.js";

export { ACCESS_ROLES, loadViewer, canAssignTo, updateOrg, ceoEmployeeId, listAssignable, listOpenBlockersFor } from "./org.js";
export {
  addTaskStep,
  setStepDone,
  recomputeProgress,
  reportProgress,
  updateTaskFields,
  linkTasks,
  resolveBlocker,
  closeTask,
  INVERSE,
  MAX_RELATIONS_PER_TASK,
  PROGRESS_BANDS,
  PROGRESS_BAND_WIDTH,
  bandMidpoint,
} from "./progress.js";
export type { ProgressBand, ProgressSource, RelationKind, TaskStep } from "./progress.js";
export {
  checkPolicyAtStartup,
  evaluatePolicy,
  isProduction,
  isQuickTunnel,
  readRegistry,
  registry,
  registryPath,
  DETECTORS,
} from "./compliance.js";
export type { Finding, PolicyReport, Registry, RegistryService } from "./compliance.js";
export { complianceEvidence, exportPersonData, recordComplianceSnapshot } from "./compliance-evidence.js";
export type { ComplianceEvidence } from "./compliance-evidence.js";
export { redactIdentifiers } from "./llm/redact.js";
export type { ViewerOrg } from "./org.js";

export { logAudit } from "./audit.js";
export type { AuditEntry } from "./audit.js";

export { createInvite, generateInviteCode } from "./invite.js";
export type { CreatedInvite } from "./invite.js";

export { enqueueNotification } from "./outbox.js";
export type { OutboxMessage, OutboxChannel } from "./outbox.js";
export { OUTBOX_CHANNELS } from "./outbox.js";

export { extractBlocker, parseTaskUpdate, blockerExtractionSchema } from "./parse.js";
export type { BlockerExtraction, ParseResult } from "./parse.js";

export {
  routeBlocker,
  routeAndAlert,
  escalateBlocker,
  acknowledgeBlocker,
  slaSweep,
  sweepUnroutedBlockers,
  slaMinutesFor,
  loadSlaMinutes,
  resolveForCategory,
} from "./routing.js";
export type { RouteResult, RouteAndAlertResult, EscalationResult, UnroutedSweepResult } from "./routing.js";

export { recordTrace, traceStats, resetTraceStats, TRACE_STEPS } from "./trace.js";
export {
  CHANNELS,
  channelAvailability,
  channelStates,
  liveChannels,
  isChannelLive,
  setChannelEnabled,
  DELIVERY_MODES,
  deliveryModeOf,
  setDeliveryMode,
  DeliveryModeError,
} from "./channels.js";
export type { Channel, ChannelState, DeliveryMode } from "./channels.js";
export {
  savePushSubscription,
  deletePushSubscription,
  pushSubscriptionsFor,
  listMyDevices,
  markPushDelivered,
  hasPushDevice,
} from "./push.js";
export type { PushSubscriptionInput, StoredPushSubscription } from "./push.js";
export { screenInboundEmail, recordInboundEmail, secretMatches, addressOf } from "./inbound-email.js";
export type { InboundEmail, InboundVerdict } from "./inbound-email.js";
export { retentionSweep, retentionDays, eraseEmployee } from "./retention.js";
export type { RetentionResult, ErasureResult } from "./retention.js";
export type { TraceStep } from "./trace.js";

export { subscribeToChanges, changeSubscriberCount, closeChangeStream } from "./changes.js";
export type { ChangeEvent, ChangeListener } from "./changes.js";

export {
  PROJECT_STATUSES,
  HEALTHS,
  REQUIREMENT_KINDS,
  MOSCOW,
  ISSUE_KINDS,
  ISSUE_STATUSES,
  MEMBER_ROLES,
  STALE_PROJECT_DAYS,
  createProject,
  updateProject,
  setProjectHealth,
  addRequirement,
  setRequirementStatus,
  addMilestone,
  setMilestoneStatus,
  addProjectMember,
  removeProjectMember,
  setTaskProject,
  addProjectUpdate,
  raiseProjectIssue,
  resolveProjectIssue,
  projectSweep,
  canManageProject,
  canContributeToProject,
} from "./projects.js";
export type {
  ProjectStatus,
  Health,
  RequirementKind,
  Moscow,
  IssueKind,
  IssueStatus,
  MemberRole,
  ProjectSweepResult,
} from "./projects.js";

export {
  ALERT_EVENT_TYPES,
  PREF_EVENT_TYPES,
  PREF_MODES,
  availableChannels,
  resolveAlertRecipients,
  notify,
  notifyPeople,
  presentationOf,
  openAlert,
  blockerAlias,
  loadEscalationLadder,
  mayAcknowledgeBlocker,
  addTaskWatcher,
  removeTaskWatcher,
  setNotificationPref,
  markNotificationsRead,
} from "./alerts.js";
export type { AlertEvent, AlertEventType, PrefEventType, AlertRecipient, NotifyResult, EscalationLevelRow, PrefMode, Presentation } from "./alerts.js";

export { replayRun } from "./replay.js";
export type { ReplayReport, ReplayCheck } from "./replay.js";

export { seedDemo } from "./seed.js";
export type { SeedCounts } from "./seed.js";

export { answerQuestion, MAX_ROWS } from "./query/answer.js";
export type { QueryResult } from "./query/answer.js";
export { validateReadOnlySql } from "./query/guard.js";
export { numericSanityGate } from "./query/gates.js";

export { llmComplete, LlmError, LlmBudgetExceededError } from "./llm/client.js";
export {
  isTracingEnabled,
  langfuseConfig,
  traceLlmCall,
  flushTraces,
  tracingStats,
  stopTracing,
  resetTracingStats,
} from "./llm/langfuse.js";
export type { LangfuseConfig, TracedCall } from "./llm/langfuse.js";
export type { LlmMessage, LlmCompleteOpts } from "./llm/client.js";
export { extractJson } from "./llm/extract.js";
export { estimateCost } from "./llm/cost.js";

export {
  validateInvite,
  redeemInvite,
  PROFILE_STEPS,
  profilePrompt,
  updateProfileField,
  ensureCeoLinked,
  withdrawConsent,
} from "./onboarding.js";
export type { InviteCheck, RedeemResult, ProfileStep, ProfileField } from "./onboarding.js";

export {
  CONSENT_POLICY_VERSION,
  consentNotice,
  dataRecipientLines,
  noticeHash,
  currentNoticeHash,
  currentNoticeHashes,
  noticeTag,
  hasCurrentConsent,
  consentStatus,
  recordConsent,
  consentKeyboard,
  requestConsentFromEveryone,
  ConsentNoticeChangedError,
} from "./consent.js";
export type { ConsentStatus } from "./consent.js";

export {
  listOpenTasks,
  createTask,
  recordTaskUpdate,
  attachNoteAndProcess,
  listEmployees,
  listOpenBlockers,
  assignTask,
} from "./updates.js";
export type {
  OpenTask,
  ReportedStatus,
  UpdateChannel,
  RecordedUpdate,
  ProcessedNote,
  DirectoryEntry,
  OpenBlocker,
  AssignmentResult,
} from "./updates.js";

export {
  transcribeAudio,
  saveVoiceAsset,
  markVoiceTranscribed,
  markVoiceFailed,
} from "./voice.js";
export type { Transcription } from "./voice.js";

export { classifyIntent, intentSchema, isObviousQuestion, summariseOwnWork, formatOwnWork } from "./intent.js";
export type { Intent, OwnWorkSummary } from "./intent.js";

export { loadMessageContext, resolveMessage, groundResolution } from "./context.js";
export { checkNamedPerson, matchPeopleByName, nameWords } from "./people-match.js";
export type { NamedPerson, PersonCheck } from "./people-match.js";
export type { MessageContext, ResolvedMessage, ResolvedItem, ContextTask, ContextPerson } from "./context.js";

export { generateEodReport, generateAllEodReports, formatEodReport } from "./eod.js";
export type { EodReport, EodTaskLine, EodBlockerLine } from "./eod.js";

export { saveAttachments, gateIncomingDocument, listAttachmentsForAssignment, describeAttachment, MAX_ATTACHMENTS } from "./attachments.js";
export type { GateResult, IncomingFile, StoredAttachment } from "./attachments.js";

export {
  extractPdfText,
  decodeTextFile,
  planDocumentTasks,
  groundDocumentTasks,
  planningDirectory,
  formatDocumentPlan,
  MAX_DOC_CHARS,
  MAX_DOC_TASKS,
} from "./documents.js";
export type { ExtractedDocument, DocumentTask, DocumentPlan } from "./documents.js";

export {
  inspectFile,
  detectFileType,
  safeFileName,
  explainVerdict,
  MAX_FILE_BYTES,
  MAX_PDF_PAGES,
  MAX_TEXT_CHARS,
} from "./document-security.js";
export type { SafetyReport, Verdict } from "./document-security.js";
export { antivirusConfig, antivirusStatus, scanBytes } from "./antivirus.js";
export type { AntivirusConfig, ScanResult } from "./antivirus.js";
export { extractPdfTextSandboxed, PdfSandboxError, PDF_SANDBOX } from "./pdf-sandbox.js";

export {
  scanForInjection,
  spotlight,
  sanitiseModelText,
  outputLooksInjected,
  logInjectionScan,
  explainInjection,
  SPOTLIGHT_RULE,
} from "./injection.js";
export type { InjectionScan } from "./injection.js";

export { checkRateLimit, LIMITS } from "./rate-limit.js";
export type { RateLimit, RateDecision } from "./rate-limit.js";

export { localTime, localDateTime, localDate, companyToday, COMPANY_TZ } from "./time.js";

export { Semaphore, QueueFullError, llmSemaphore, documentSemaphore, concurrencyStats } from "./concurrency.js";
export type { SemaphoreStats } from "./concurrency.js";
export { escapeMarkdown } from "./document-security.js";

// Email in and out (TASK-053).
export { emailAllowlist, emailAddressAllowed, emailStatus, inboxConfig, replyToAddress } from "./email-config.js";
export type { InboxConfig } from "./email-config.js";
export {
  authPasses,
  emailAddressOf,
  extractReply,
  formatTaskKey,
  normaliseMessageId,
  parseEmailStatus,
  parseReferences,
  readAuthResults,
  taskNumberFromSubject,
  TASK_KEY_PREFIX,
} from "./email-reply.js";
export { composeOutboundEmail, recordOutboundEmail } from "./email-outbound.js";
export type { EmailPayload, OutboundEmail } from "./email-outbound.js";
export {
  processInboundEmail,
  screenAndRoute,
  listPendingEmailProposals,
  pendingEmailProposal,
  recordWebhookProposal,
  decideEmailProposal,
  unreadInboundEmails,
  storedInboundMessage,
  MAX_EMAIL_ATTEMPTS,
} from "./email-inbound.js";
export type { InboundEmailMessage, InboundEmailOutcome, EmailProposalRow } from "./email-inbound.js";
export { relevantPeople, CONTEXT_LIMITS } from "./context-scope.js";
export type { ScopedPeople } from "./context-scope.js";
export { setEmployeeEmail, emailOverview, emailHealth, EmailAddressError } from "./email-people.js";
export type { EmailOverview } from "./email-people.js";
